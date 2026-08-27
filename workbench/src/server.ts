/**
 * The workbench sidecar's HTTP surface.
 *
 * Binds loopback only, always: the browser reaches it through the axum
 * server's /api/workbench/* proxy, so the workbench adds no port to the
 * network (docs/agent-workbench.md §1.2).
 *
 * SSE down, POST up — the same shape server/src/routes/watch.rs already uses.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { foldAll, reduce, type SessionView, type TranscriptTool } from '../../src/workbench/fold.ts';
import { folderOf } from '../../src/workbench/protocol.ts';
import type { WbpCommand } from '../../src/workbench/protocol.ts';
import { whatItRan } from '../../src/workbench/said-what-it-ran.ts';
import { issuesForSession, sessionsForIssue } from './bd.ts';
import { cardsForOpen, sweepClaims } from './chat-cards.ts';
import { conversationTitle } from './conversation-title.ts';
import { watchOutside } from './outside.ts';
import { planUsage, watchUsage } from './plan-usage.ts';
import { codexUsage, watchCodexUsage } from './codex-usage.ts';
import { codexThreadProcesses, knownSessions, providerHoldsNow, restoreList } from './registry.ts';
import { withOutsideHolds } from '../../src/workbench/restore-status.ts';
import type { HeldChat } from '../../src/workbench/chat-state.ts';
import { rememberSummaryRuns } from './running.ts';
import { boundedEvent, Sessions } from './sessions.ts';
import { Store } from './store.ts';
import { summaryMemoryOf } from './summary-runs.ts';
import { readProviderDefaults, writeProviderDefault } from './provider-defaults.ts';

// The operating system picks the port unless somebody names one. It used to be
// 3009 always, and the app forwarded there on trust: whatever program held that
// port received the reader's conversation and answered the health check in our
// name (bw-8um.3.5). The parent now learns the port from the line printed at the
// bottom of this file, so it can only ever reach a helper it started itself.
const PORT = Number(process.env.BEADS_WORKBENCH_PORT ?? 0);

// A word the parent invented and told only this process. Any program on this
// computer can reach a loopback port; without this, one could drive the reader's
// own chat. Empty when nobody set it — somebody running this helper by hand is
// its only caller anyway.
const TOKEN = process.env.ATELIER_WORKBENCH_TOKEN ?? '';
const TOKEN_HEADER = 'x-atelier-workbench';

const store = new Store();
// Nothing survives a restart except the record of it, so no row may claim to
// be running until a click brings it back.
store.markAllDormant();
const sessions = new Sessions(store);

/** Provider locks excluding processes owned by this sidecar itself. */
function outsideHoldsNow(fresh = false): HeldChat[] {
  const codex = codexThreadProcesses();
  return providerHoldsNow(fresh).filter((hold) => {
    if (!sessions.drivesExternal(hold.id)) return true;
    const owners = codex.get(hold.id.toLowerCase());
    if (!owners) return false;
    const ours = sessions.processForExternal(hold.id);
    return ours === null || Array.from(owners).some((pid) => pid !== ours);
  });
}
// The bar over a compaction fills against this project's own middle run, once
// enough of them have been watched from beginning to end (bw-jaoz.14.9).
rememberSummaryRuns(summaryMemoryOf(store));

const TRANSCRIPT_WINDOW = 40;

/** Which event began a folded row. Used only when one message also produced a
 * thinking row and a 40-anchor query therefore folded slightly more than 40
 * rows: the cursor moves to the first row actually sent, so none are skipped. */
function starts(event: ReturnType<Store['transcriptWindow']>['events'][number], item: SessionView['items'][number]): boolean {
  if (item.kind === 'message') return event.type === 'message.started' && event.messageId === item.id;
  if (item.kind === 'thinking') return event.type === 'message.started' && event.messageId === item.id;
  if (item.kind === 'tool') return event.type === 'tool.started' && event.toolCallId === item.id;
  if (item.kind === 'ask') return event.type === 'ask.permission' && event.askId === item.id;
  if (item.kind === 'note') return event.type === 'note' && event.noteId === item.id;
  return event.type === 'notice' && `notice-${event.seq}` === item.id;
}

function transcriptPage(sessionId: string, before: number | null): {
  items: SessionView['items']; cursor: number | null; hasOlder: boolean; newestSeq: number;
} {
  const page = store.transcriptWindow(sessionId, before, TRANSCRIPT_WINDOW);
  const folded = foldAll(page.events.map(boundedEvent));
  const visible = folded.items.slice(-TRANSCRIPT_WINDOW);
  const truncated = visible.length < folded.items.length;
  const first = visible[0];
  const cursor = truncated && first
    ? (page.events.find((event) => starts(event, first))?.seq ?? page.cursor)
    : page.cursor;
  return {
    items: visible.map((item) => {
      if (item.kind !== 'tool') return item;
      const ran = whatItRan(item.name, item.input);
      return {
        ...item,
        input: {},
        output: null,
        diff: null,
        detailsDeferred: true,
        ranKind: ran?.kind,
        ranGrave: ran?.grave,
      } satisfies TranscriptTool;
    }),
    cursor,
    hasOlder: page.hasOlder || truncated,
    newestSeq: page.newestSeq,
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One session's stream: the conversation as it stands, then the live tail.
 *
 * A browser opening a chat is handed the newest transcript window in one
 * `snapshot` frame. SQLite selects only that window; older windows are fetched
 * on upward scroll and tool bodies on disclosure. Virtualising after a complete
 * replay still paid to fold and transfer everything, which is why the longest
 * Codex chat took seconds to show forty rows.
 *
 * A browser that reconnects passes the last seq it saw, and is sent only what
 * arrived since: no snapshot, because it is already drawing one.
 */
/**
 * When the reader last asked us for anything.
 *
 * The sidecar answers everything on one thread, so work nobody is waiting for
 * has to stand aside while he is using it (bw-uiyz.12).
 */
let lastAsk = 0;

/** How long after the reader's last request the thread counts as his own. */
const READER_QUIET_MS = 1_500;

function streamEvents(req: IncomingMessage, res: ServerResponse, sessionId: string, since: number): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // The axum proxy streams bytes through untouched; this tells any other
    // hop in the chain not to sit on them.
    'x-accel-buffering': 'no',
  });
  const send = (chunk: string) => res.write(chunk);

  const write = (e: unknown) => {
    const safe = boundedEvent(e as Parameters<typeof boundedEvent>[0]);
    send(`id: ${(safe as { seq: number }).seq}\ndata: ${JSON.stringify(safe)}\n\n`);
  };

  if (since === 0) {
    const page = transcriptPage(sessionId, null);
    const facts = foldAll(store.sessionFactsEvents(sessionId).map(boundedEvent));
    const view: SessionView = {
      ...facts,
      items: page.items,
      state: facts.state,
      stateLabel: facts.stateLabel,
      menu: facts.menu,
      model: facts.model,
      permissionMode: facts.permissionMode,
      cost: facts.cost,
      context: facts.context,
      todos: facts.todos,
      agents: facts.agents,
      beads: store.beadsForSession(sessionId),
      thinkingTokens: facts.thinkingTokens,
      error: facts.error,
      lastSeq: page.newestSeq,
      historyCursor: page.cursor,
      hasOlder: page.hasOlder,
    };
    // Named, so the browser tells the conversation apart from an event; the id
    // is what a reconnection resumes from, whether ours or the browser's own.
    send(`id: ${view.lastSeq}\nevent: snapshot\ndata: ${JSON.stringify(view)}\n\n`);
  } else {
    for (const e of sessions.replay(sessionId, since)) write(e);
  }
  const unsubscribe = sessions.subscribe(sessionId, write);

  // Keeps intermediaries from reaping an idle stream, same 30s cadence as watch.rs.
  const beat = setInterval(() => send(': keep-alive\n\n'), 30_000);
  const done = () => {
    clearInterval(beat);
    unsubscribe();
  };
  req.on('close', done);
  req.on('error', done);
}

/**
 * How often the marker files are re-read while anyone is watching.
 *
 * Nobody sends us an event when a person opens a terminal, so this is a look
 * rather than a wait: a directory listing of a handful of small files and one
 * signal-0 per process, which is why it can afford to be this often. The
 * reader caches for the same span, so a look never costs twice.
 */
const RUNNING_BEAT_MS = 2_000;

const runningWatchers = new Set<(holds: HeldChat[]) => void>();
let runningBeat: ReturnType<typeof setInterval> | null = null;
/** The last answer announced, flattened, purely to tell a change from a repeat. */
let announced = '';

/**
 * What is announced, and what a repeat is measured on: who is held and what
 * each of them is doing. Not the stamp beside it — that moves only when the
 * doing does, and keying on it would put a frame on the wire every beat for a
 * chat that has been answering all along.
 */
function heldKey(holds: HeldChat[]): string {
  return holds.map((h) => `${h.id}:${h.holder}:${h.doing}:${h.detail ?? ''}`).join(',');
}

function lookAtRunning(): void {
  const holds = outsideHoldsNow();
  const key = heldKey(holds);
  if (key === announced) return;
  announced = key;
  runningWatchers.forEach((tell) => tell(holds));
}

/**
 * Tells the caller which conversations live processes are holding, and again
 * whenever that changes. One timer for every browser watching rather than one
 * each, and none at all when nobody is.
 */
function watchRunning(tell: (holds: HeldChat[]) => void): () => void {
  runningWatchers.add(tell);
  if (!runningBeat) runningBeat = setInterval(lookAtRunning, RUNNING_BEAT_MS);
  return () => {
    runningWatchers.delete(tell);
    if (runningWatchers.size > 0 || !runningBeat) return;
    clearInterval(runningBeat);
    runningBeat = null;
    announced = '';
  };
}

/**
 * Every session at once: a snapshot, then the live tail. The tray, the glance
 * strip and the board's live dots all read this one stream, so a browser holds
 * one connection however many of them are on screen.
 */
function streamAll(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const write = (frame: unknown) => res.write(`data: ${JSON.stringify(frame)}\n\n`);
  write({
    kind: 'snapshot',
    sessions: store.listSessions().map((s) => ({
      ...s,
      activity: sessions.activity(s.id),
      // The cards each chat has touched, so a board card can show its own live
      // chat without asking about every card on the board.
      beads: store.beadsForSession(s.id),
    })),
  });
  // Straight after the snapshot, because a chat somebody is working in has no
  // row in our store to appear in one, and the rail marks its rows off this.
  write({ kind: 'running', holds: outsideHoldsNow() });
  // The account's own allowance, whether or not this browser has a chat open
  // and however long that chat has been silent: this server reads it on a beat
  // of its own and every page hears the same figure at the same moment
  // (plan-usage.ts, bw-dmoe). Watching says the figure in hand straight away,
  // so a page that opens after the first read draws it without waiting for the
  // next beat — and one that opens before there is any hears it the moment
  // there is one. Saying it here as well sent every stream the same frame twice
  // (bw-dmoe.6).
  const unwatchUsage = watchUsage((usage) => write({ kind: 'usage', brand: 'claude', usage }));
  const unwatchCodexUsage = watchCodexUsage((usage) => write({ kind: 'usage', brand: 'codex', usage }));
  const unsubscribe = sessions.watch((e) => write({ kind: 'event', event: e }));
  const unopen = sessions.watchOpen((s) => write({ kind: 'opened', session: { ...s, activity: '', beads: [] } }));
  const unwatchRunning = watchRunning((holds) => write({ kind: 'running', holds }));
  // A chat begun in an editor or a terminal has no event of ours to arrive on
  // and no row here to carry one; the only sign of it is the tool writing its
  // record. Hearing that folder move is the whole of what tells this browser
  // to ask for the list again (outside.ts, bw-uivp.1).
  const unwatchOutside = watchOutside((folders) => write({ kind: 'outside', folders }));

  const beat = setInterval(() => res.write(': keep-alive\n\n'), 30_000);
  const done = () => {
    clearInterval(beat);
    unsubscribe();
    unopen();
    unwatchRunning();
    unwatchOutside();
    unwatchUsage();
    unwatchCodexUsage();
  };
  req.on('close', done);
  req.on('error', done);
}

async function handleCommand(res: ServerResponse, cmd: WbpCommand): Promise<void> {
  switch (cmd.type) {
    case 'provider-defaults.read':
      json(res, 200, readProviderDefaults(cmd.brand));
      return;
    case 'provider-defaults.write':
      json(res, 200, await writeProviderDefault(cmd.brand, cmd.kind, cmd.value));
      return;
    case 'session.start': {
      const s = await sessions.start(cmd);
      json(res, 200, s);
      return;
    }
    case 'prompt.send':
      json(res, 200, {
        ok: true,
        messageId: await sessions.send(cmd.sessionId, cmd.text, cmd.images ?? [], cmd.takeover ?? false),
      });
      return;
    case 'ask.answer':
      sessions.answer(cmd.sessionId, cmd.askId, cmd.optionId, cmd.value);
      json(res, 200, { ok: true });
      return;
    case 'session.open': {
      const s = await sessions.open(cmd);
      json(res, 200, s);
      return;
    }
    case 'session.resume': {
      const s = await sessions.resume(cmd);
      json(res, 200, s);
      return;
    }
    case 'session.stop':
      await sessions.stop(cmd.sessionId, cmd.retractMessageId);
      json(res, 200, { ok: true });
      return;
    case 'session.close':
      await sessions.close(cmd.sessionId);
      json(res, 200, { ok: true });
      return;
    case 'agent.stop':
      await sessions.stopAgent(cmd.sessionId, cmd.agentId);
      json(res, 200, { ok: true });
      return;
    case 'agent.park':
      json(res, 200, { ok: true, parked: await sessions.parkAgent(cmd.sessionId, cmd.agentId) });
      return;
    case 'agent.say':
      await sessions.relay(cmd.sessionId, cmd.agentId, cmd.text);
      json(res, 200, { ok: true });
      return;
    case 'session.mode':
      await sessions.pin(cmd.sessionId, { mode: cmd.mode });
      json(res, 200, { ok: true });
      return;
    case 'session.model':
      await sessions.pin(cmd.sessionId, { model: cmd.model });
      json(res, 200, { ok: true });
      return;
    case 'session.effort':
      await sessions.pin(cmd.sessionId, { effort: cmd.effort });
      json(res, 200, { ok: true });
      return;
    default:
      json(res, 400, { error: `unknown command ${(cmd as { type: string }).type}` });
  }
}

const server = createServer((req, res) => {
  if (TOKEN && req.headers[TOKEN_HEADER] !== TOKEN) {
    json(res, 403, { error: 'this helper answers only the app that started it' });
    return;
  }
  // Only the path and the query are read off it; the host is a formality.
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  lastAsk = Date.now();
  const path = url.pathname.replace(/^\/api\/workbench/, '') || '/';

  void (async () => {
    try {
      if (path === '/health') {
        json(res, 200, { status: 'ok', sidecar: 'workbench' });
      } else if (path === '/events' && req.method === 'GET') {
        const sessionId = url.searchParams.get('session');
        if (!sessionId) return json(res, 400, { error: 'session is required' });
        const since = Number(req.headers['last-event-id'] ?? url.searchParams.get('since') ?? 0);
        // Reading a chat is what starts the watching of it, so a reader who
        // arrived by the address alone is caught up exactly as far as one who
        // clicked the row (bw-ja9l.8).
        //
        // Started, never waited for: reading a record takes as long as the
        // record is long, and awaited here it held the whole stream shut —
        // a chat with a day's work behind it drew nothing at all for half a
        // minute, and this helper answers one thing at a time, so every other
        // reader waited with it (bw-ja9l.9). What the record says arrives on
        // this same stream a moment later, which is the way every other fact
        // about a followed chat already arrives.
        void sessions.lookedAt(sessionId);
        streamEvents(req, res, sessionId, Number.isFinite(since) ? since : 0);
      } else if (path === '/search' && req.method === 'GET') {
        const q = (url.searchParams.get('q') ?? '').trim();
        json(res, 200, q ? sessions.found(q) : []);
      } else if (path === '/history' && req.method === 'GET') {
        const sessionId = url.searchParams.get('session');
        const before = Number(url.searchParams.get('before'));
        if (!sessionId || !Number.isFinite(before)) return json(res, 400, { error: 'session and before are required' });
        const page = transcriptPage(sessionId, before);
        json(res, 200, {
          items: page.items,
          cursor: page.cursor,
          hasOlder: page.hasOlder,
        });
      } else if (path === '/tool' && req.method === 'GET') {
        const sessionId = url.searchParams.get('session');
        const toolCallId = url.searchParams.get('tool');
        if (!sessionId || !toolCallId) return json(res, 400, { error: 'session and tool are required' });
        const detail = store.toolDetails(sessionId, toolCallId);
        json(res, detail ? 200 : 404, detail ?? { error: `no tool ${toolCallId}` });
      } else if (path === '/spend' && req.method === 'GET') {
        json(res, 200, store.spend());
      } else if (path === '/usage' && req.method === 'GET') {
        // The account's allowance, not this chat's. The pages themselves are
        // pushed it down /watch and never ask; this answers a first paint and
        // the tools that ask from a terminal (bw-malh, bw-dmoe).
        json(res, 200, url.searchParams.get('brand') === 'codex' ? await codexUsage() : await planUsage());
      } else if (path === '/tokens' && req.method === 'GET') {
        // This chat's own two numbers, unlike /usage above, which is the
        // account's: what fills the window now, and what the task has spent
        // since its first word (bw-3ug7).
        const sessionId = url.searchParams.get('session');
        if (!sessionId) return json(res, 400, { error: 'session is required' });
        json(res, 200, await sessions.tokenPicture(sessionId));
      } else if (path === '/watch' && req.method === 'GET') {
        streamAll(req, res);
      } else if (path.startsWith('/links/bead/') && req.method === 'GET') {
        // The board decides WHICH chats are listed — it is the record. Our own
        // rows only supply the title and the time, and a chat the board has
        // forgotten must not linger here just because we cached it. If the
        // board cannot be read at all, the cache stands in rather than the
        // card losing its chats entirely.
        const beadId = decodeURIComponent(path.slice('/links/bead/'.length));
        const cwd = url.searchParams.get('path') ?? process.cwd();
        const cached = new Map(store.sessionsForBead(beadId).map((s) => [s.id, s]));
        const onBoard = await sessionsForIssue(beadId, cwd);
        const ids = onBoard.length > 0 ? onBoard : [...cached.keys()];
        json(
          res,
          200,
          ids.map((sessionId) => {
            const s = cached.get(sessionId);
            return {
              sessionId,
              title: s?.title ?? null,
              brand: s?.brand ?? null,
              lastActiveAt: s?.lastActiveAt ?? null,
              projectId: s?.projectId ?? null,
            };
          }),
        );
      } else if (path.startsWith('/links/session/') && req.method === 'GET') {
        const sessionId = decodeURIComponent(path.slice('/links/session/'.length));
        const s = store.getSession(sessionId);
        const onBoard = s ? await issuesForSession(sessionId, s.cwd) : [];
        json(res, 200, [...new Set([...store.beadsForSession(sessionId), ...onBoard])]);
      } else if (path.startsWith('/session/') && req.method === 'GET') {
        // What the open chat shows about itself. The cards asked for are this
        // chat's own — what the board recorded against this session — and they
        // are remembered here so its row carries them next time too.
        const sessionId = decodeURIComponent(path.slice('/session/'.length));
        const s = store.getSession(sessionId);
        if (!s) return json(res, 404, { error: `no session ${sessionId}` });
        const seen = (await knownSessions(s.projectPath)).find((k) => k.brand === s.brand && k.externalId === s.externalId);
        const beads = await cardsForOpen(store, sessionId, s.cwd);
        const cwd = seen?.cwd ?? s.cwd;
        json(res, 200, {
          sessionId,
          origin: s.origin,
          brand: s.brand,
          externalId: s.externalId,
          // Said here as well as on the stream, because the writing box must
          // refuse from the first frame it draws (protocol.ts, SessionFacts).
          runningElsewhere: s.externalId !== null && outsideHoldsNow(true)
            .some((hold) => hold.id.toLowerCase() === s.externalId?.toLowerCase()),
          // And what that program is doing, so the chat draws a moving mark
          // from its first frame rather than a beat later (bw-96is).
          held: s.externalId === null ? null : (outsideHoldsNow(true)
            .find((hold) => hold.id.toLowerCase() === s.externalId?.toLowerCase()) ?? null),
          title: seen?.name ?? conversationTitle(s.title ?? ''),
          cwd,
          folder: folderOf(cwd),
          branch: seen?.branch ?? null,
          beads,
        });
        // The board's own claim stamps are the only link a chat run in a
        // terminal has. Read for every chat at once, after this one has been
        // answered, so no open waits on the whole board (chat-cards.ts).
        void sweepClaims(store, s.cwd, store.listSessions());
      } else if (path === '/restore' && req.method === 'GET') {
        const id = url.searchParams.get('project');
        const projectPath = url.searchParams.get('path');
        const everything = url.searchParams.get('all') === '1';
        const rows = await restoreList(store, id && projectPath ? { id, path: projectPath } : null, everything);
        json(res, 200, withOutsideHolds(rows, outsideHoldsNow(true)));
      } else if (path === '/sessions' && req.method === 'GET') {
        json(res, 200, sessions ? store.listSessions(url.searchParams.get('project') ?? undefined) : []);
      } else if (path === '/command' && req.method === 'POST') {
        await handleCommand(res, JSON.parse(await readBody(req)) as WbpCommand);
      } else {
        json(res, 404, { error: `no route ${path}` });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) json(res, 500, { error: message });
      else res.end();
    }
  })();
});

server.listen(PORT, '127.0.0.1', () => {
  const bound = server.address();
  const port = typeof bound === 'object' && bound ? bound.port : PORT;
  // The parent reads this exact line to learn where to send traffic, so its
  // shape is a contract between the two — see server/src/routes/workbench.rs.
  console.log(`[workbench] listening 127.0.0.1:${port}`);
  // The first click on a chat used to wait for its whole record to be read.
  // It is read here instead, with nobody waiting (bw-uiyz.12).
  void sessions.readAhead(() => Date.now() - lastAsk < READER_QUIET_MS).then((read) => {
    if (read > 0) console.log(`[workbench] ${read} chat(s) read ahead`);
  });
});
