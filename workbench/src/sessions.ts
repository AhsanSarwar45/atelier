/**
 * The live half of the workbench: which sessions have a driver attached, and
 * fanning their events out to the event log and to every open browser.
 *
 * Every event is written to the log before it is broadcast, so a browser that
 * reconnects and replays sees exactly what a browser that stayed connected saw.
 */
import { randomUUID } from 'node:crypto';

import type { Brand, ImagePayload, SessionState, SessionSummary, WbpEvent } from '../../src/workbench/protocol.ts';
import { DEFAULT_PERMISSION_MODE } from '../../src/workbench/protocol.ts';
import { ClaudeDriver } from './drivers/claude.ts';
import type { Driver, DriverEvent, PermissionAnswer } from './drivers/types.ts';
import type { Store } from './store.ts';

type Subscriber = (e: WbpEvent) => void;

export class Sessions {
  private drivers = new Map<string, Driver>();
  private subs = new Map<string, Set<Subscriber>>();
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

    const driver = new ClaudeDriver();
    this.drivers.set(summary.id, driver);
    await driver.start({
      cwd: summary.cwd,
      model: params.model,
      permissionMode: summary.permissionMode,
      emit: (e) => this.publish(summary.id, e),
    });
    return summary;
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

    if (full.type === 'session.state') {
      this.store.updateSession(sessionId, { state: full.state as SessionState });
    } else if (full.type === 'session.started') {
      this.store.updateSession(sessionId, { externalId: full.externalId, model: full.model });
    }

    for (const sub of this.subs.get(sessionId) ?? []) sub(full);
  }

  subscribe(sessionId: string, fn: Subscriber): () => void {
    if (!this.subs.has(sessionId)) this.subs.set(sessionId, new Set());
    this.subs.get(sessionId)!.add(fn);
    return () => this.subs.get(sessionId)?.delete(fn);
  }

  replay(sessionId: string, since: number): WbpEvent[] {
    return this.store.eventsSince(sessionId, since);
  }
}
