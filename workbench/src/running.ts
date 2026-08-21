/**
 * The disk and the process table behind "who is working in this chat right now".
 *
 * Claude Code writes one marker file per running process at
 * `<config>/sessions/<pid>.json` and names in it the conversation that process
 * is on. This reads that directory, asks the operating system whether each
 * named process is still there, and hands the answer to `restoreList` so a chat
 * somebody is typing at in a terminal stops being drawn as asleep
 * (docs/agent-workbench.md §6.3, bw-dmxj.3).
 *
 * The judging of the markers is `src/workbench/running.ts`, which is pure and
 * carries the reasoning; this file is the part that touches the machine.
 *
 * **The `.key` files beside them are not ours.** The sessions directory also
 * holds `<pid>.<hash>.key`, mode 0600 — credentials for the tool's own
 * messaging socket. Only `<pid>.json` is read here, and nothing in this file
 * ever opens anything else.
 *
 * **Nothing here writes.** A marker whose process is gone is ignored, never
 * deleted: the files belong to Claude Code, which cleans up after itself, and a
 * reader that starts removing another program's state is a bug waiting for a
 * race.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { heldDoing } from '../../src/workbench/chat-state.ts';
import type { HeldChat } from '../../src/workbench/chat-state.ts';
import { parseMarker, procStartFromStat, runningChats } from '../../src/workbench/running.ts';
import type { RunningChat, SessionMarker } from '../../src/workbench/running.ts';
import { findRecord } from './record-tail.ts';

/**
 * Where the tool keeps its state, resolved the way the tool resolves it:
 * `CLAUDE_CONFIG_DIR` when it is set, `~/.claude` otherwise. An install that
 * moved its config directory moved its markers with it, and reading the default
 * path anyway would report every chat on the machine as asleep.
 */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/**
 * Every marker on disk that parses. Synchronous on purpose: this is a handful
 * of files of a few hundred bytes each — six on the machine it was measured on
 * — read at most once every couple of seconds, and the sidecar's own store
 * reads its database the same way.
 */
export function readMarkers(): SessionMarker[] {
  const dir = join(claudeConfigDir(), 'sessions');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // No directory at all: no Claude Code has run under this config, which is
    // an ordinary state and not an error. Nothing is running.
    return [];
  }

  const markers: SessionMarker[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch {
      // Written, then removed, between the listing and the read: the process it
      // named has just exited, so it was not going to count anyway.
      continue;
    }
    const marker = parseMarker(text);
    if (marker) markers.push(marker);
  }
  return markers;
}

/**
 * The process's start time as the kernel counts it, or nothing if it is gone.
 * Linux only — the caller does not ask elsewhere.
 */
function procStartOf(pid: number): string | null {
  try {
    return procStartFromStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Is the process this marker names still the process that wrote it?
 *
 * Two questions, because the first one alone is not enough. `kill(pid, 0)`
 * sends no signal and only asks whether the number belongs to something —
 * `EPERM` means somebody else's process, which is still a process and still
 * alive, while `ESRCH` and everything else mean gone. But process numbers are
 * handed out again, and a marker left behind by a crash can name a number the
 * kernel has since given to an unrelated program, which would make a chat that
 * died last week look like one being typed at.
 *
 * So on Linux the start time must match as well: same number, same process. If
 * `/proc` cannot be read for a number `kill` had just accepted, the process
 * exited in between and the honest answer is no. A machine with no `/proc` at
 * all reads every chat as not running — exactly the behaviour this feature
 * replaces, which is the right way to degrade.
 *
 * macOS and Windows are shipped targets and have no `/proc`; there, existence
 * is the whole test. Node documents signal `0` as an existence check on every
 * platform, and any throw is caught here regardless, so neither one can be
 * crashed by this.
 *
 * Not caught: a process that has exited but not yet been reaped still answers
 * both questions. It is a state that lasts until its parent looks, and no
 * cheaper check distinguishes it from a live one.
 */
export function processIsAlive(marker: SessionMarker): boolean {
  try {
    process.kill(marker.pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  if (process.platform !== 'linux') return true;
  const started = procStartOf(marker.pid);
  return started !== null && started === marker.procStart;
}

/**
 * How stale an answer a caller can be handed. Two seconds is below what a
 * person notices in a list of chats and far above the rate any screen asks at,
 * so the directory is read a few times a minute however many callers there are.
 */
const REFRESH_MS = 2_000;

let cached = new Map<string, RunningChat>();
let cachedAt = 0;

/**
 * Every conversation a live Claude Code process is holding, by session id.
 *
 * Cheap to call: the answer is remembered for `REFRESH_MS`, so a caller in a
 * loop over forty rows costs one directory read, not forty.
 *
 * `fresh` reads the directory whatever the memory says, and a caller taking a
 * decision ONCE must pass it. Whether to follow a chat being opened is such a
 * decision: nothing revisits it, so a two-second-old answer leaves a chat that
 * started being worked in a moment ago drawn as a dead record for as long as it
 * stays open (bw-dmxj.8). A screen redrawing itself is the opposite case and
 * wants the memory.
 */
export function runningNow(fresh = false): Map<string, RunningChat> {
  const now = Date.now();
  if (!fresh && now - cachedAt < REFRESH_MS) return cached;
  cachedAt = now;
  cached = runningChats(readMarkers(), processIsAlive);
  return cached;
}

/**
 * When each held conversation was first seen working in the burst it is in now.
 *
 * The seconds a reader watches must be the turn's, not the beat's: the record
 * of a host-driven chat is re-stat-ed every couple of seconds, and counting
 * from the last stat would reset the number to zero on every look. Entries for
 * conversations nothing holds any more are dropped on the next look, so this
 * cannot grow past the number of chats running on the machine.
 */
const burstAt = new Map<string, number>();

/**
 * What every held conversation is doing, ready for the wire.
 *
 * The holder's own `status` answers where there is one, and a stat of its
 * record answers where there is not — see {@link heldDoing} for why that is the
 * right signal for THIS question and the wrong one for liveness. One stat per
 * held chat with no status, on the same beat that already reads the marker
 * directory.
 */
export function holdsNow(fresh = false): HeldChat[] {
  const running = runningNow(fresh);
  const now = Date.now();
  const holds: HeldChat[] = [];
  const seen = new Set<string>();

  running.forEach((chat, id) => {
    seen.add(id);
    const record = chat.status === null ? findRecord(id) : null;
    let movedAt: number | null = null;
    if (record) {
      try {
        movedAt = statSync(record).mtimeMs;
      } catch {
        // The record can be rotated or removed while we look; a chat whose
        // record we cannot stat is one we know nothing about, which is what
        // `unknown` is for.
        movedAt = null;
      }
    }
    const { doing, since } = heldDoing({
      status: chat.status,
      statusAt: chat.statusAt,
      recordMovedAt: movedAt,
      burstAt: burstAt.get(id) ?? null,
      now,
    });
    if (doing === 'working') {
      if (!burstAt.has(id)) burstAt.set(id, since ?? now);
    } else {
      burstAt.delete(id);
    }
    holds.push({
      id,
      // A person at a terminal and a program driving through the kit are the
      // same fact to everything that acts on this (§6.3.4); the badge names
      // which only because a reader looking for their own terminal wants to
      // know which window to go to.
      holder: chat.entrypoint === 'cli' ? 'terminal' : 'program',
      doing,
      since: doing === 'working' ? (burstAt.get(id) ?? since) : null,
    });
  });

  burstAt.forEach((_, id) => {
    if (!seen.has(id)) burstAt.delete(id);
  });
  return holds.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
