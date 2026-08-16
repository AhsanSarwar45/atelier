/**
 * The live half of the workbench: which sessions have a driver attached, and
 * fanning their events out to the event log and to every open browser.
 *
 * Every event is written to the log before it is broadcast, so a browser that
 * reconnects and replays sees exactly what a browser that stayed connected saw.
 */
import { getSessionMessages, type SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';

import type { Brand, ImagePayload, SessionState, SessionSummary, WbpEvent } from '../../src/workbench/protocol.ts';
import { DEFAULT_PERMISSION_MODE } from '../../src/workbench/protocol.ts';
import {
  IMPORTED_MESSAGES,
  saidByAnyone,
  textOf,
  toolCallsOf,
  withoutMachineChatter,
} from '../../src/workbench/imported-history.ts';
import { ClaudeDriver } from './drivers/claude.ts';
import type { Driver, DriverEvent, PermissionAnswer } from './drivers/types.ts';
import { Linker } from './linker.ts';
import type { Store } from './store.ts';

type Subscriber = (e: WbpEvent) => void;

export class Sessions {
  private drivers = new Map<string, Driver>();
  private linkers = new Map<string, Linker>();
  private subs = new Map<string, Set<Subscriber>>();
  /** Listeners on every session at once — the app's single global stream. */
  private watchers = new Set<Subscriber>();
  /** Listeners told when a session comes into existence, before it says anything. */
  private openings = new Set<(s: SessionSummary) => void>();
  /**
   * The agent's own words for what each session is doing. Held here rather than
   * in the store: it is true only while a driver is attached, and a screen
   * opened later would otherwise be told a session is "Answering" when nothing
   * has been running since the last restart.
   */
  private labels = new Map<string, string>();
  // Declared, not a parameter property: Node's strip-only TypeScript mode
  // rejects `constructor(private store: Store)`.
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** Starts a driver and returns as soon as the session row exists, not when the agent replies. */
  async start(params: {
    projectId: string;
    projectPath: string;
    brand: Brand;
    model?: string;
    permissionMode?: string;
    brief?: { beadId: string; text: string };
  }): Promise<SessionSummary> {
    if (params.brand !== 'claude') {
      throw new Error(`No driver for brand "${params.brand}" yet — see docs/agent-workbench.md §3.2`);
    }
    const now = new Date().toISOString();
    const summary: SessionSummary = {
      id: randomUUID(),
      brand: params.brand,
      externalId: null,
      projectId: params.projectId,
      projectPath: params.projectPath,
      cwd: params.projectPath,
      model: params.model ?? null,
      permissionMode: params.permissionMode ?? DEFAULT_PERMISSION_MODE,
      title: null,
      state: 'starting',
      createdAt: now,
      lastActiveAt: now,
    };
    this.store.createSession({ ...summary, origin: 'app' });
    this.openings.forEach((fn) => fn(summary));

    await this.attach(summary, params.model);

    // Started FROM a card: the owner said so by pressing the button there, so
    // the link is recorded now rather than waited for. The brief is the chat's
    // own first turn, which is why it appears in the transcript like any other.
    if (params.brief) {
      this.publish(summary.id, { type: 'link.bead', beadId: params.brief.beadId, via: 'brief' });
      await this.send(summary.id, params.brief.text);
    }
    return summary;
  }

  /**
   * Brings a session back: the one the app ran, or one begun in a terminal.
   * Only ever called from a click — nothing here runs on its own (decision 8).
   */
  async resume(params: {
    sessionId?: string;
    externalId?: string;
    brand: Brand;
    projectId: string;
    projectPath: string;
  }): Promise<SessionSummary> {
    const existing = params.sessionId ? this.store.getSession(params.sessionId) : undefined;
    if (existing && this.drivers.has(existing.id)) return existing;

    const now = new Date().toISOString();
    const summary: SessionSummary =
      existing ??
      {
        id: randomUUID(),
        brand: params.brand,
        externalId: params.externalId ?? null,
        projectId: params.projectId,
        projectPath: params.projectPath,
        cwd: params.projectPath,
        model: null,
        permissionMode: DEFAULT_PERMISSION_MODE,
        title: null,
        state: 'starting',
        createdAt: now,
        lastActiveAt: now,
      };
    if (!existing) this.store.createSession({ ...summary, origin: 'terminal' });
    this.openings.forEach((fn) => fn(summary));

    // A row the app already knows keeps whatever state it was left in — dormant,
    // after a restart — and no driver event says otherwise until the owner types
    // something. Saying so here is what makes the row stop offering itself.
    this.publish(summary.id, { type: 'session.state', state: 'starting', label: 'Coming back' });

    const resumeId = params.externalId ?? summary.externalId ?? undefined;
    // What was said before this app ever saw the chat, so opening it is not a
    // blank screen (docs/agent-workbench.md §6.3.2).
    await this.importPast({ ...summary, externalId: resumeId ?? null });
    await this.attach(summary, summary.model ?? undefined, resumeId);
    return { ...summary, state: 'starting' };
  }

  /**
   * Reads what was already said in a chat out of the agent kit's own record and
   * writes it into the event log as the events that would have carried it.
   *
   * Once only: the log is the transcript (§4), so importing twice would say
   * everything twice. Text alone becomes a row — the tool calls of a past chat
   * are not replayable and a row saying one ran tells the reader nothing they
   * can act on (docs/agent-workbench.md §6.3.2). The calls are still read, by
   * the same rules the live watcher uses, for the cards and the reports they
   * name; without that a chat this app never watched can never show either.
   */
  private async importPast(summary: SessionSummary): Promise<void> {
    if (!summary.externalId) return;
    // Judged on what was SAID, not on what is in the log: a resume writes its
    // own "coming back" line before this runs.
    const alreadySaid = this.store.messageCount(summary.id) > 0;
    // A chat read in by an older build has its words but not its doings; the
    // scan is what gives it back, so having said something is not enough to
    // skip it.
    const alreadyScanned = alreadySaid && this.store.beadsForSession(summary.id).length > 0;
    if (alreadySaid && alreadyScanned) return;

    let messages: SessionMessage[];
    try {
      messages = await getSessionMessages(summary.externalId, { dir: summary.cwd });
    } catch {
      return; // No record to read: the chat simply starts where it is.
    }

    // What it did, read before what it said, so the chat's cards and reports are
    // already on the line by the time the first message is drawn.
    if (!alreadyScanned) {
      const past = new Linker(summary.id, summary.cwd, (e) => this.publish(summary.id, e));
      for (const m of messages) {
        for (const call of toolCallsOf(m.message)) past.observe(call.name, call.input);
      }
    }
    if (alreadySaid) return;

    const said = messages
      .filter((m): m is SessionMessage & { type: 'user' | 'assistant' } => m.type === 'user' || m.type === 'assistant')
      .map((m) => ({ role: m.type, text: textOf(m.message) }))
      .filter((m) => saidByAnyone(m.text));
    if (said.length === 0) return;

    const shown = said.slice(-IMPORTED_MESSAGES);
    if (said.length > shown.length) {
      this.publish(summary.id, {
        type: 'notice',
        text: `${said.length - shown.length} earlier messages are in this chat and are not drawn here.`,
      });
    }
    for (const message of shown) {
      const messageId = randomUUID();
      this.publish(summary.id, { type: 'message.started', messageId, role: message.role });
      this.publish(summary.id, { type: 'text.delta', messageId, text: message.text });
      this.publish(summary.id, { type: 'message.completed', messageId });
    }
  }

  /** Starts the driver for a session row and wires its linker. */
  private async attach(summary: SessionSummary, model?: string, resume?: string): Promise<void> {
    const driver = new ClaudeDriver();
    this.drivers.set(summary.id, driver);
    this.linkers.set(
      summary.id,
      new Linker(summary.id, summary.cwd, (e) => this.publish(summary.id, e)),
    );
    await driver.start({
      cwd: summary.cwd,
      model,
      permissionMode: summary.permissionMode,
      resume,
      emit: (e) => this.publish(summary.id, e),
    });
  }

  async send(sessionId: string, text: string, images: ImagePayload[] = []): Promise<void> {
    const driver = this.require(sessionId);
    // The user's own turn belongs in the transcript before the agent answers it.
    const messageId = randomUUID();
    this.publish(sessionId, { type: 'message.started', messageId, role: 'user' });
    for (const image of images) this.publish(sessionId, { type: 'image', messageId, image });
    this.publish(sessionId, { type: 'text.delta', messageId, text });
    this.publish(sessionId, { type: 'message.completed', messageId });

    const s = this.store.getSession(sessionId);
    if (s && !s.title) this.store.updateSession(sessionId, { title: text.slice(0, 80) });

    await driver.send({ text, images });
  }

  answer(sessionId: string, askId: string, optionId: string): void {
    this.require(sessionId).answer(askId, optionId as PermissionAnswer);
  }

  async stop(sessionId: string): Promise<void> {
    await this.require(sessionId).interrupt();
  }

  private require(sessionId: string): Driver {
    const d = this.drivers.get(sessionId);
    if (!d) throw new Error(`session ${sessionId} is not running`);
    return d;
  }

  /** Stamps identity onto a driver event, logs it, then fans it out. */
  private publish(sessionId: string, e: DriverEvent): void {
    const full = {
      ...e,
      seq: this.store.nextSeq(sessionId),
      sessionId,
      at: new Date().toISOString(),
    } as WbpEvent;

    this.store.appendEvent(full);

    // The linker reads OUR vocabulary, not the brand's, so every driver feeds it.
    if (full.type === 'tool.started') {
      this.linkers.get(sessionId)?.observe(full.name, full.input);
    } else if (full.type === 'link.bead') {
      this.store.rememberBeadLink(sessionId, full.beadId, full.via);
    } else if (full.type === 'report.available') {
      this.store.rememberReportLink(sessionId, full.project, full.slug);
    }

    // What was said and what it cost, folded out of the log as it goes by, so
    // searching and totalling never re-read every event of every session.
    if (full.type === 'message.started') {
      this.store.openMessage(sessionId, full.messageId, full.role, full.at);
    } else if (full.type === 'text.delta') {
      this.store.growMessage(sessionId, full.messageId, full.text);
    } else if (full.type === 'cost') {
      const s = this.store.getSession(sessionId);
      this.store.rememberTurn({
        sessionId,
        projectId: s?.projectId ?? '',
        brand: s?.brand ?? 'claude',
        at: full.at,
        usd: full.cost.kind === 'usd' ? full.cost.usd : null,
        input: full.cost.kind === 'tokens' ? full.cost.input : null,
        output: full.cost.kind === 'tokens' ? full.cost.output : null,
        total: full.cost.kind === 'tokens' ? full.cost.total : null,
      });
    }

    if (full.type === 'session.state') {
      this.store.updateSession(sessionId, { state: full.state as SessionState });
      this.labels.set(sessionId, full.label);
    } else if (full.type === 'session.started') {
      this.store.updateSession(sessionId, { externalId: full.externalId, model: full.model });
    }

    for (const sub of this.subs.get(sessionId) ?? []) sub(full);
    for (const sub of this.watchers) sub(full);
  }

  subscribe(sessionId: string, fn: Subscriber): () => void {
    if (!this.subs.has(sessionId)) this.subs.set(sessionId, new Set());
    this.subs.get(sessionId)!.add(fn);
    return () => this.subs.get(sessionId)?.delete(fn);
  }

  /**
   * Every session's events, for the one stream the whole app watches: the
   * waiting-on-you tray, the glance strip and the live dot on a board card all
   * read from it, so the browser holds one connection rather than one per
   * component (docs/agent-workbench.md §8.6).
   */
  watch(fn: Subscriber): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  /**
   * A session exists from the moment it is created, not from its first word.
   * The card it was started from is linked before the agent has said anything,
   * so a screen that only learned of sessions from their events would never
   * hear about that link at all.
   */
  watchOpen(fn: (s: SessionSummary) => void): () => void {
    this.openings.add(fn);
    return () => this.openings.delete(fn);
  }

  /** What each attached session last said it was doing. */
  activity(sessionId: string): string {
    return this.labels.get(sessionId) ?? '';
  }

  /**
   * Matches with enough around them to read: the sentence the words fell in,
   * and which chat and project it was said in.
   */
  found(q: string): {
    sessionId: string;
    messageId: string;
    role: string;
    sentence: string;
    match: string;
    at: string;
    title: string | null;
    projectId: string;
  }[] {
    return this.store.search(q).map((m) => {
      const at = m.text.toLowerCase().indexOf(q.toLowerCase());
      // The sentence it fell in: back to the last full stop, on to the next.
      const from = Math.max(0, m.text.lastIndexOf('.', Math.max(0, at - 1)) + 1);
      const stop = m.text.indexOf('.', at + q.length);
      const s = this.store.getSession(m.sessionId);
      return {
        sessionId: m.sessionId,
        messageId: m.messageId,
        role: m.role,
        sentence: m.text.slice(from, stop < 0 ? Math.min(m.text.length, at + 240) : stop + 1).trim(),
        match: m.text.slice(at, at + q.length),
        at: m.at,
        title: s?.title ?? null,
        projectId: s?.projectId ?? '',
      };
    });
  }

  /**
   * The log as a reader should see it. The harness's own messages are dropped
   * here rather than at the point they were written, so a chat read in by an
   * older build stops showing them without being read again — reading it again
   * would say everything twice (§4).
   */
  replay(sessionId: string, since: number): WbpEvent[] {
    return withoutMachineChatter(this.store.eventsSince(sessionId, since));
  }
}
