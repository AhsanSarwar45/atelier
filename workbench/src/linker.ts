/**
 * Who touched what, recorded by watching — never by asking the agent.
 *
 * Sits above the drivers and reads our own `tool.started` events, so a third
 * brand gets linking for nothing. Design: docs/agent-workbench.md §6.1.
 *
 * What counts as touching a card is in src/workbench/link-rules.ts. Here the
 * candidates it puts forward are confirmed against the board before any of
 * them becomes a link.
 */
import type { DriverEvent } from './drivers/types.ts';
import { candidatesFrom } from '../../src/workbench/link-rules.ts';
import { issueExists, recordTranscriptLink } from './bd.ts';

export class Linker {
  private cwd: string;
  private sessionId: string;
  private emit: (e: DriverEvent) => void;
  /** Verdicts already reached this session, so `bd` is asked once per token. */
  private verdicts = new Map<string, boolean>();
  private linked = new Set<string>();
  /** Serialises the bd calls so one busy turn cannot fork a process storm. */
  private queue: Promise<void> = Promise.resolve();

  constructor(sessionId: string, cwd: string, emit: (e: DriverEvent) => void) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.emit = emit;
  }

  /** Feed every tool call here. Returns immediately; the board is written behind it. */
  observe(name: string, input: Record<string, unknown>): void {
    const candidates = candidatesFrom(name, input).filter((id) => !this.linked.has(id));
    if (!candidates.length) return;
    this.queue = this.queue.then(() => this.confirmAndRecord(candidates)).catch(() => {});
  }

  private async confirmAndRecord(candidates: string[]): Promise<void> {
    for (const id of candidates) {
      if (this.linked.has(id)) continue;

      let real = this.verdicts.get(id);
      if (real === undefined) {
        real = (await issueExists(id, this.cwd)).exists;
        this.verdicts.set(id, real);
      }
      if (!real) continue;

      this.linked.add(id);
      // The board is the record; ours is a cache. Firing per call is safe —
      // bd collapses repeats of the same pair into one edge.
      await recordTranscriptLink(id, this.sessionId, this.cwd, 'workbench-tool');
      this.emit({ type: 'link.bead', beadId: id, via: 'tool' });
    }
  }
}
