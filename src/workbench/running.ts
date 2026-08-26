/**
 * Which conversations a live Claude Code process is holding right now.
 *
 * The restore list (docs/agent-workbench.md §6.3) has until now drawn every
 * chat it did not itself start as asleep, so a chat being typed at in a
 * terminal looked exactly like one that died last week. It isn't a cosmetic
 * difference: a row that is asleep is an offer to wake it, and the offer is
 * wrong when somebody is already working in there.
 *
 * The signal is the tool's own: Claude Code writes one marker file per running
 * process at `<config>/sessions/<pid>.json`, naming the conversation that
 * process is on. Measured on this machine, 2026-08-19 (bw-dmxj.3): six markers
 * present, six live processes, every `procStart` matching the kernel's.
 *
 * **Not the transcript's mtime.** The obvious-looking signal — the SDK's
 * `lastModified` on the session index — is the conversation file's mtime and
 * nothing more, and it was measured wrong for this: one genuinely working chat
 * was silent for 488 seconds while another wrote every 5 (bw-dmxj). The SDK's
 * `SDKSessionInfo` carries no liveness field at all, so it cannot answer this
 * question and we do not ask it to.
 *
 * This half is pure so it can be tested without processes: the disk and the
 * process table live in `workbench/src/running.ts`, which injects the liveness
 * test into `runningChats`.
 *
 * **A host counts the same as a terminal.** The marker says whether a person is
 * typing at a terminal (`cli`) or a program is driving (`sdk-cli`, `sdk-ts`),
 * and nothing here branches on it. Measured on this machine, 2026-08-19
 * (bw-dmxj.13): the one live `sdk-ts` marker was Zed's Claude agent, seven
 * hours into a conversation in this repository. Somebody is working in there,
 * through a host rather than a terminal, and a rule that counted only terminals
 * would draw that chat as asleep and offer to wake a second agent on it — which
 * is the whole of what this signal exists to prevent.
 */
// Named the way Node resolves it — the file, extension and all: the chat's own
// server reads this file raw, and knows nothing of the browser build's `@/`.
import { asleepHere, type SessionState } from './protocol.ts';

/** Current ownership, deliberately separate from immutable session origin. */
export type SessionOwnership =
  | { kind: 'atelier' }
  | { kind: 'elsewhere'; externalId: string }
  | { kind: 'unheld'; externalId: string | null };

/**
 * One provider-neutral ownership state machine.
 *
 * A terminal-created chat is not permanently external. While no driver is
 * attached it is unheld and may be resumed by the first send; while another
 * live process holds it, it is external and read-only; once Atelier attaches,
 * it is ours regardless of where it was originally created.
 */
export function sessionOwnership(
  state: SessionState,
  externalId: string | null | undefined,
  heldByAnother: boolean,
): SessionOwnership {
  if (externalId && heldByAnother) return { kind: 'elsewhere', externalId };
  if (!asleepHere(state)) return { kind: 'atelier' };
  return { kind: 'unheld', externalId: externalId ?? null };
}

/** Whether the shared composer may accept a message. An external chat accepts
 * a draft too; sending it performs the explicit ownership transfer. */
export function canCompose(ownership: SessionOwnership): boolean {
  return ownership.kind === 'atelier' || ownership.kind === 'unheld' || ownership.kind === 'elsewhere';
}

/**
 * One marker file, as the tool writes it.
 *
 * Only the fields we act on are named; a marker also carries the version, a
 * messaging socket path and a derived display name, which are the tool's
 * business and not ours. The `status` pair beside them IS ours now: it is the
 * only thing on the machine that says whether a chat somebody else holds is
 * working or waiting, and drawing "working" over a terminal sitting at an
 * empty prompt was what made the word meaningless (bw-96is).
 */
export interface SessionMarker {
  /** The conversation this process is on — the id the SDK's index uses too. */
  sessionId: string;
  pid: number;
  /** Where the process is working: a worktree's path is the worktree. */
  cwd: string;
  /** When the chat began, ms since the epoch. */
  startedAt: number;
  /**
   * The process's own start time as the kernel counts it — field 22 of
   * `/proc/<pid>/stat`, in clock ticks since boot, kept verbatim as the string
   * it was written as. This is what tells a live chat from a stale marker whose
   * process number has since been handed to something else.
   */
  procStart: string;
  /** `cli` when a person is at a terminal, `sdk-cli`/`sdk-ts` when a host drives it. */
  entrypoint: string;
  /** `interactive` for a chat somebody talks to. */
  kind: string;
  /**
   * What that process says it is doing — `busy` while it owes an answer,
   * `idle` when it is waiting on its own reader — or null when it says
   * nothing.
   *
   * Optional where the seven above are required, because only some processes
   * write it: measured on this machine 2026-08-21, all seven terminal markers
   * carried it and none of the six host-driven ones did. It is the difference
   * between knowing a chat is occupied and knowing it is working, so a marker
   * without it is still a marker.
   */
  status: string | null;
  /** When it last said so, ms since the epoch, or null with no status. */
  statusAt: number | null;
}

/** A conversation a live process is holding, as the rest of the app needs it. */
export interface RunningChat {
  sessionId: string;
  pid: number;
  cwd: string;
  startedAt: number;
  entrypoint: string;
  /** What that process last said it was doing, or null when it does not say. */
  status: string | null;
  /** When it said it, ms since the epoch, or null. */
  statusAt: number | null;
}

/**
 * Whether the process a marker names is still the process that wrote it.
 * Injected, because asking the real one means real processes and the unit test
 * has none.
 */
export type IsAlive = (marker: SessionMarker) => boolean;

function isText(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * One marker file's contents, validated, or nothing.
 *
 * Never throws: this reads files another program writes while we are reading
 * them, so a half-written line, a truncated file or a shape a later version
 * invents must all come back as "no marker" rather than take the sidecar down.
 *
 * The seven that describe the process are required; the `status` pair is not,
 * because only some processes write it (see {@link SessionMarker.status}), and
 * a marker without it still says who is holding what.
 *
 * Every other named field is required. A marker missing one is a shape we have not
 * measured, and the house rule on other people's formats holds here as it does
 * for the session index (§6.3): we stand behind what the tool documented by
 * writing it, and ignore what we would have to guess at. If a later version
 * drops one of the descriptive fields — `kind`, `entrypoint`, `cwd` — this is
 * the line to loosen; the four that carry identity and liveness (`sessionId`,
 * `pid`, `startedAt`, `procStart`) cannot be loosened at all.
 */
export function parseMarker(text: string): SessionMarker | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (!isText(m.sessionId) || !isText(m.procStart) || !isText(m.cwd)) return null;
  if (!isText(m.entrypoint) || !isText(m.kind)) return null;
  if (typeof m.pid !== 'number' || !Number.isInteger(m.pid) || m.pid <= 0) return null;
  if (typeof m.startedAt !== 'number' || !Number.isFinite(m.startedAt)) return null;
  return {
    sessionId: m.sessionId,
    pid: m.pid,
    cwd: m.cwd,
    startedAt: m.startedAt,
    procStart: m.procStart,
    entrypoint: m.entrypoint,
    kind: m.kind,
    status: isText(m.status) ? m.status : null,
    statusAt: typeof m.statusUpdatedAt === 'number' && Number.isFinite(m.statusUpdatedAt)
      ? m.statusUpdatedAt
      : null,
  };
}

/**
 * Field 22 of a `/proc/<pid>/stat` line: the process's start time.
 *
 * Split on the LAST `)`, never on whitespace from the left. Field 2 is the
 * executable's name in parentheses and the kernel does not escape it, so a
 * process called `foo (bar)` shifts every field after it and a naive split
 * reads the wrong number — which here would mean calling a live chat dead, or
 * worse, calling a recycled process number the same chat. After the closing
 * parenthesis the fields resume at 3 (the run state), so 22 is the 20th.
 *
 * Pure, and here rather than beside the file read, because the parenthesis rule
 * is the part worth a test.
 */
export function procStartFromStat(line: string): string | null {
  const close = line.lastIndexOf(')');
  if (close < 0) return null;
  const after = line.slice(close + 1).trim();
  if (after.length === 0) return null;
  return after.split(/\s+/)[19] ?? null;
}

/**
 * The conversations somebody is working in, by session id.
 *
 * A marker whose process is gone is simply not in the answer; the file itself
 * is left alone, because it is the tool's to write and the tool's to clean up,
 * and deleting another program's state on a hunch is how a reader turns into a
 * bug.
 *
 * Two markers can name the same conversation — a chat resumed in a second
 * terminal, or one whose marker outlived a crash and whose number came back
 * around. The newest by `startedAt` wins, and only among the ones still
 * running: an older live process beats a newer dead one, because the question
 * is who is working in there now, not who was last to start.
 */
export function runningChats(markers: SessionMarker[], alive: IsAlive): Map<string, RunningChat> {
  const newest = new Map<string, SessionMarker>();
  for (const marker of markers) {
    if (!alive(marker)) continue;
    const had = newest.get(marker.sessionId);
    if (had && had.startedAt >= marker.startedAt) continue;
    newest.set(marker.sessionId, marker);
  }

  // `forEach` rather than `for…of` over the map: this file is compiled by the
  // browser half's tsconfig too, which targets ES5 and rejects iterating a Map.
  const running = new Map<string, RunningChat>();
  newest.forEach((m, sessionId) => {
    running.set(sessionId, {
      sessionId,
      pid: m.pid,
      cwd: m.cwd,
      startedAt: m.startedAt,
      entrypoint: m.entrypoint,
      status: m.status,
      statusAt: m.statusAt,
    });
  });
  return running;
}

/**
 * Is the chat on the screen one that ANOTHER program is driving?
 *
 * The writing box turns on this. Typing into such a chat would wake a second
 * agent on the same conversation and the two would write over each other's
 * record, so the box says why instead (bw-dmxj.6).
 *
 * Asleep is half the question, and it is the half that is easy to leave out.
 * Every agent this app drives is itself a Claude Code process and writes its
 * own marker, so OUR OWN open chat is in the running set exactly like a
 * terminal's. What tells them apart is that a chat we drive is idle between
 * turns and never dormant — and without that half the box would lock during
 * our own work, which is when steering matters most.
 *
 * `running` is null until the app-wide stream has said what is running, which
 * is a beat after the chat itself is drawn — and a beat is long enough to type
 * a message into a box that looks ordinary. So the chat's own facts carry what
 * was true when it was opened, and that answers until the stream speaks; once
 * it has, the stream is the answer, because the other program may have
 * stopped since (bw-dmxj.8).
 */
export function heldElsewhere(
  state: SessionState,
  externalId: string | null | undefined,
  running: ReadonlySet<string> | null,
  saidAtOpen = false,
): boolean {
  const held = !!externalId && (running === null ? saidAtOpen : running.has(externalId));
  return sessionOwnership(state, externalId, held).kind === 'elsewhere';
}
