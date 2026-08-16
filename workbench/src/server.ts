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

import { folderOf } from '../../src/workbench/protocol.ts';
import type { WbpCommand } from '../../src/workbench/protocol.ts';
import { issuesByActor, issuesForSession, sessionsForIssue } from './bd.ts';
import { knownSessions, restoreList } from './registry.ts';
import { Sessions } from './sessions.ts';
import { Store } from './store.ts';

const PORT = Number(process.env.BEADS_WORKBENCH_PORT ?? 3009);

const store = new Store();
// Nothing survives a restart except the record of it, so no row may claim to
// be running until a click brings it back.
store.markAllDormant();
const sessions = new Sessions(store);

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
 * One session's stream: replay from `since`, then tail live. A browser that
 * reconnects passes the last seq it saw and misses nothing.
 */
function streamEvents(req: IncomingMessage, res: ServerResponse, sessionId: string, since: number): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // The axum proxy streams bytes through untouched; this tells any other
    // hop in the chain not to sit on them.
    'x-accel-buffering': 'no',
  });

  const write = (e: unknown) => {
    res.write(`id: ${(e as { seq: number }).seq}\ndata: ${JSON.stringify(e)}\n\n`);
  };

  for (const e of sessions.replay(sessionId, since)) write(e);
  const unsubscribe = sessions.subscribe(sessionId, write);

  // Keeps intermediaries from reaping an idle stream, same 30s cadence as watch.rs.
  const beat = setInterval(() => res.write(': keep-alive\n\n'), 30_000);
  const done = () => {
    clearInterval(beat);
    unsubscribe();
  };
  req.on('close', done);
  req.on('error', done);
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
  const unsubscribe = sessions.watch((e) => write({ kind: 'event', event: e }));
  const unopen = sessions.watchOpen((s) => write({ kind: 'opened', session: { ...s, activity: '', beads: [] } }));

  const beat = setInterval(() => res.write(': keep-alive\n\n'), 30_000);
  const done = () => {
    clearInterval(beat);
    unsubscribe();
    unopen();
  };
  req.on('close', done);
  req.on('error', done);
}

async function handleCommand(res: ServerResponse, cmd: WbpCommand): Promise<void> {
  switch (cmd.type) {
    case 'session.start': {
      const s = await sessions.start(cmd);
      json(res, 200, s);
      return;
    }
    case 'prompt.send':
      await sessions.send(cmd.sessionId, cmd.text, cmd.images ?? []);
      json(res, 200, { ok: true });
      return;
    case 'ask.answer':
      sessions.answer(cmd.sessionId, cmd.askId, cmd.optionId);
      json(res, 200, { ok: true });
      return;
    case 'session.resume': {
      const s = await sessions.resume(cmd);
      json(res, 200, s);
      return;
    }
    case 'session.stop':
      await sessions.stop(cmd.sessionId);
      json(res, 200, { ok: true });
      return;
    default:
      json(res, 400, { error: `unknown command ${(cmd as { type: string }).type}` });
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname.replace(/^\/api\/workbench/, '') || '/';

  void (async () => {
    try {
      if (path === '/health') {
        json(res, 200, { status: 'ok', sidecar: 'workbench' });
      } else if (path === '/events' && req.method === 'GET') {
        const sessionId = url.searchParams.get('session');
        if (!sessionId) return json(res, 400, { error: 'session is required' });
        const since = Number(req.headers['last-event-id'] ?? url.searchParams.get('since') ?? 0);
        streamEvents(req, res, sessionId, Number.isFinite(since) ? since : 0);
      } else if (path === '/search' && req.method === 'GET') {
        const q = (url.searchParams.get('q') ?? '').trim();
        json(res, 200, q ? sessions.found(q) : []);
      } else if (path === '/spend' && req.method === 'GET') {
        json(res, 200, store.spend());
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
        // What the open chat shows about itself. The cards are the board's
        // answer, so a chat begun in a terminal has them from the first look;
        // they are remembered here so its row carries them next time too.
        const sessionId = decodeURIComponent(path.slice('/session/'.length));
        const s = store.getSession(sessionId);
        if (!s) return json(res, 404, { error: `no session ${sessionId}` });
        const seen = (await knownSessions(s.projectPath)).find((k) => k.externalId === s.externalId);
        const [linked, claimed] = await Promise.all([
          issuesForSession(sessionId, s.cwd),
          issuesByActor((s.externalId ?? '').slice(0, 8), s.cwd),
        ]);
        const onBoard = [...new Set([...linked, ...claimed])];
        for (const beadId of onBoard) store.rememberBeadLink(sessionId, beadId, 'board');
        const cwd = seen?.cwd ?? s.cwd;
        json(res, 200, {
          sessionId,
          title: seen?.name ?? s.title,
          cwd,
          folder: folderOf(cwd),
          branch: seen?.branch ?? null,
          beads: [...new Set([...store.beadsForSession(sessionId), ...onBoard])],
        });
      } else if (path === '/restore' && req.method === 'GET') {
        const id = url.searchParams.get('project');
        const projectPath = url.searchParams.get('path');
        json(res, 200, await restoreList(store, id && projectPath ? { id, path: projectPath } : null));
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
  console.log(`[workbench] sidecar listening on http://127.0.0.1:${PORT}`);
});
