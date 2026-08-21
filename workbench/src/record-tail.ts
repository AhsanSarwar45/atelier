/**
 * Reading a chat's record on from where it was last read.
 *
 * A chat somebody else is driving is watched through the record the kit writes,
 * and every beat that found the file moved used to read the whole of it and
 * take it apart again — 475ms and 158 megabytes on the manager's longest
 * conversation, every 1.5s, on the one thread the sidecar answers every other
 * request from (bw-uiyz.6).
 *
 * Nothing older can change: the record is written by appending. So the file is
 * opened at the byte the last read stopped at, and only what has arrived since
 * is parsed. A record that came back SHORTER than it was has been rewritten —
 * the kit compacted it — and the caller is told so rather than being handed the
 * new file's opening as if it were new conversation.
 *
 * The kit's own reader is still the one that reads a chat from the beginning:
 * it follows the record's parent links and hands back the conversation as it
 * now stands, which appended lines alone cannot say.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { claudeConfigDir } from './running.ts';

/**
 * One line of the record: what it is and what was said in it. The same shape
 * the kit's own reader hands back, which is what reads a past chat and what
 * measures how full it stands.
 */
export interface RecordLine {
  type?: string;
  /** The line's own name, which is how a reader says where it stopped. */
  uuid?: string;
  message?: unknown;
  isSidechain?: boolean;
  isMeta?: boolean;
  /**
   * The mode the chat was in when this line was written. The kit stamps it onto
   * a line of its own every time the mode changes, and onto the prompts a
   * person types (bw-ja9l.2).
   */
  permissionMode?: string;
}

/**
 * What a chat is running, as its own record says it.
 *
 * Both facts are written down and neither reaches the app: the kit's reader
 * hands back conversation and nothing else, so a chat begun in a terminal drew
 * no model and no mode for its whole life. Null on a field means the record did
 * not say — never a guess, because the only guess to hand is this machine's own
 * settings and the terminal may be in any mode at all (bw-ja9l.2).
 */
export interface Running {
  /** The mode the record was last put into. */
  permissionMode: string | null;
  /** The model that last answered in the conversation itself. */
  model: string | null;
}

/** Nothing said either way. */
export const SAYS_NOTHING: Running = { permissionMode: null, model: null };

/**
 * Saying what a chat is running, in an order that never unsays it.
 *
 * Two readers answer the same question about a followed chat. One is a
 * catch-up: a single read of the record as it already stands, so a terminal
 * that has not changed mode since it opened still says which mode that is. The
 * other is the beat, which reads the lines that arrive after it.
 *
 * They resolve in whatever order the disk hands them back, and the catch-up
 * reads the WHOLE record, so it is the slow one. A terminal switched into
 * `bypassPermissions` a moment after the chat was opened is published by the
 * first beat and then overwritten by the catch-up's older snapshot — the chip
 * goes back to saying the chat still asks first, which is the one thing the
 * chip exists to be right about (bw-ja9l.5).
 *
 * So the catch-up only ever fills a blank. It cannot be newer than a beat: it
 * read the file as it stood before the beat's lines were written. The beat may
 * overwrite anything, because every line it reads was written after everything
 * the catch-up saw.
 *
 * A null field says nothing on that subject and leaves what is known standing,
 * which is the rule the event itself carries.
 */
export function saysWhatItRuns(publish: (running: Running) => void): {
  beat: (found: Running) => void;
  caughtUp: (found: Running) => void;
} {
  const shown: Running = { ...SAYS_NOTHING };
  const say = (found: Running, catchingUp: boolean): void => {
    const keep = <T>(mine: T | null, standing: T | null): T | null =>
      catchingUp && standing !== null ? standing : (mine ?? standing);
    const permissionMode = keep(found.permissionMode, shown.permissionMode);
    const model = keep(found.model, shown.model);
    if (permissionMode === shown.permissionMode && model === shown.model) return;
    shown.permissionMode = permissionMode;
    shown.model = model;
    publish({ permissionMode, model });
  };
  return {
    beat: (found) => say(found, false),
    caughtUp: (found) => say(found, true),
  };
}

/** What one look at the end of the record found. */
export interface Grown {
  /** The lines that have arrived since the last look, in the order written. */
  fresh: RecordLine[];
  /**
   * What those same bytes said about the mode and the model, last one wins. A
   * field is null when they said nothing about it, which leaves whatever was
   * already known standing.
   */
  running: Running;
  /** The record is shorter than it was: it has been rewritten under us. */
  rewritten: boolean;
  /** How many bytes were read to find that out — zero when nothing moved. */
  read: number;
}

/**
 * The kit's record for a conversation, found by looking rather than by guessing
 * how it spells a directory name from a path.
 *
 * One listing of the projects directory, at the moment a chat starts being
 * watched.
 */
export function findRecord(sessionId: string, config: string = claudeConfigDir()): string | null {
  const projects = join(config, 'projects');
  let folders: string[];
  try {
    folders = readdirSync(projects);
  } catch {
    return null;
  }
  for (const folder of folders) {
    const candidate = join(projects, folder, `${sessionId}.jsonl`);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this project's folder; try the next.
    }
  }
  return null;
}

/**
 * How long a chat's record stands right now.
 *
 * Asked before a whole-record read, so the follower knows the byte to carry on
 * from and nothing written while that read was going on is skipped.
 */
export function recordSize(sessionId: string, config?: string): number | null {
  const path = findRecord(sessionId, config);
  if (path === null) return null;
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/**
 * Every line of a record, from its first to its last.
 *
 * The kit's own reader is the one that hands back a chat as it NOW STANDS, and
 * that is not the same thing: a conversation that has compacted twelve times
 * comes back from it as the turns since the twelfth, and asking it what a long
 * day cost answered 37 turns and 5 million tokens against a file holding 2,313
 * turns and 531 million (measured 2026-08-20, bw-3ug7.5). The file is where the
 * whole task is, because the kit appends to it across every forgetting rather
 * than starting a new one.
 *
 * The kit's bookkeeping is dropped and the conversation kept, by the same rule
 * the follower uses. Whole-file: 124ms on that same 30MB record, which is a
 * click and not a wait. Empty when there is no such file to read.
 */
export function allLines(path: string): RecordLine[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const lines: RecordLine[] = [];
  for (const line of text.split('\n')) {
    const row = readLine(line);
    if (row !== null) lines.push(row);
  }
  return lines;
}

/**
 * What the record says the chat is running, read from its END.
 *
 * Both answers are the LAST thing the record says on their subject, so the
 * search starts at the end with a small window and doubles it until it has both
 * or has read the whole file — the same shape {@link linePlace} uses, and for
 * the same reason: on the manager's longest conversation a whole-record read is
 * 124ms and 30MB, and this runs when a chat is opened.
 *
 * A chat that has been talking says both in its last few kilobytes. One that
 * has not costs the widening, which is the honest price of an answer that is
 * read rather than guessed.
 */
export async function runningIn(path: string): Promise<Running> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return { ...SAYS_NOTHING };
  }
  if (size === 0) return { ...SAYS_NOTHING };
  const handle = await open(path, 'r');
  try {
    for (let window = 1 << 16; ; window *= 2) {
      const from = Math.max(0, size - window);
      const buf = Buffer.alloc(size - from);
      await handle.read(buf, 0, buf.length, from);
      const lines = buf.toString('utf8').split('\n');
      // A window that does not reach the start of the file opens in the middle
      // of a line. That line belongs to the next, wider look.
      if (from > 0) lines.shift();
      const found: Running = { permissionMode: null, model: null };
      for (const line of lines) sipRunning(line, found);
      // The whole file has been read, so nothing more is coming; otherwise keep
      // widening until both are answered.
      if (from === 0 || (found.permissionMode !== null && found.model !== null)) return found;
    }
  } finally {
    await handle.close();
  }
}

/**
 * Where the line naming this one sits in the record, looked for from the END.
 *
 * `begins` is its first byte and `after` the first byte of whatever follows it.
 * Both are answers to the same question a reader has when it has to say where
 * it stands: a whole-record read holds back the rows whose commands have no
 * answers yet, and it stops at a byte PAST them, so neither the lines it held
 * nor the ones it finished can be named in bytes without this (bw-uiyz.19).
 *
 * The lines in question are the last few of a record, so the search starts at
 * the end with a small window and doubles it. Null when the record, or the
 * line, is not there.
 */
export async function linePlace(
  sessionId: string,
  name: string,
  config?: string,
): Promise<{ begins: number; after: number } | null> {
  const path = findRecord(sessionId, config);
  if (path === null) return null;
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return null;
  }
  // Written by the kit as the line's own field. The leading quote is what keeps
  // it from matching the NEXT line's `parentUuid`, which names this same line.
  const needle = `"uuid":"${name}"`;
  const handle = await open(path, 'r');
  try {
    for (let window = 1 << 16; ; window *= 2) {
      const from = Math.max(0, size - window);
      const buf = Buffer.alloc(size - from);
      await handle.read(buf, 0, buf.length, from);
      const text = buf.toString('utf8');
      const found = text.indexOf(needle);
      const before = found === -1 ? -1 : text.lastIndexOf('\n', found);
      // A hit in the window's first line is only trustworthy when that line is
      // whole — either the window reaches the start of the file, or a newline
      // stands before it.
      if (found !== -1 && (before !== -1 || from === 0)) {
        const ends = text.indexOf('\n', found);
        return {
          begins: from + before + 1,
          // The record's last line is written without its newline until the
          // next one lands, so there is nothing after it yet.
          after: ends === -1 ? size : from + ends + 1,
        };
      }
      if (from === 0) return null;
    }
  } finally {
    await handle.close();
  }
}

/**
 * A record being read a piece at a time.
 *
 * Holds one number — where it has read to — and whatever trailing bytes did not
 * make a whole line yet, so a line caught half-written is read whole on the
 * next look instead of being dropped.
 */
export class RecordTail {
  private at = 0;
  private partial = '';
  private readonly decoder = new StringDecoder('utf8');
  // Declared, not a parameter property: Node's strip-only TypeScript mode
  // rejects `constructor(readonly path: string)` and the sidecar runs on it.
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** The byte the next look starts from. */
  get position(): number {
    return this.at;
  }

  /**
   * The byte after the last WHOLE line taken in.
   *
   * `position` counts the bytes read, and a look that caught a line
   * half-written holds the rest of it in hand rather than in the file. A later
   * reader carrying on from that byte would start inside a line and lose it, so
   * what is remembered between opens is this one (bw-uiyz.19).
   */
  get throughLine(): number {
    return this.at - Buffer.byteLength(this.partial, 'utf8');
  }

  /** Carry on from a byte a previous reader stopped at. */
  seek(at: number): void {
    this.at = Math.max(0, at);
    this.partial = '';
  }

  /** Start from the end of what is there now, without reading any of it. */
  async toEnd(): Promise<void> {
    try {
      this.at = (await stat(this.path)).size;
    } catch {
      this.at = 0;
    }
    this.partial = '';
  }

  /** What has arrived since the last look. */
  async grown(): Promise<Grown> {
    let size: number;
    try {
      size = (await stat(this.path)).size;
    } catch {
      return { fresh: [], running: { ...SAYS_NOTHING }, rewritten: false, read: 0 };
    }
    if (size < this.at) {
      this.at = size;
      this.partial = '';
      return { fresh: [], running: { ...SAYS_NOTHING }, rewritten: true, read: 0 };
    }
    if (size === this.at) return { fresh: [], running: { ...SAYS_NOTHING }, rewritten: false, read: 0 };

    const length = size - this.at;
    const buffer = Buffer.allocUnsafe(length);
    const handle = await open(this.path, 'r');
    let got = 0;
    try {
      ({ bytesRead: got } = await handle.read(buffer, 0, length, this.at));
    } finally {
      await handle.close();
    }
    this.at += got;

    const text = this.partial + this.decoder.write(buffer.subarray(0, got));
    const lines = text.split('\n');
    // The last piece has no newline after it: either the file ends there or the
    // line is still being written. Either way it waits for the next look.
    this.partial = lines.pop() ?? '';

    const fresh: RecordLine[] = [];
    // Every line, not only the conversation: the mode a terminal is switched to
    // is written on a line of its own, which is not conversation and is the
    // only place that fact exists (bw-ja9l.2).
    const running: Running = { ...SAYS_NOTHING };
    for (const line of lines) {
      sipRunning(line, running);
      const said = readLine(line);
      if (said) fresh.push(said);
    }
    return { fresh, running, rewritten: false, read: got };
  }
}

/**
 * One line, if it is conversation.
 *
 * The record also carries the kit's own bookkeeping — the mode it is in, the
 * titles it made up, snapshots of files — and the turns of agents a chat sent
 * off, which belong to their own conversation and not to this one.
 */
function readLine(line: string): RecordLine | null {
  const row = parsed(line);
  if (row === null) return null;
  if (row.type !== 'user' && row.type !== 'assistant') return null;
  if (row.isSidechain === true || row.isMeta === true) return null;
  return row;
}

/**
 * One line as JSON, whatever the kit wrote it for.
 *
 * The extra fields are declared optional above rather than being cast away
 * here, so the two readers below — the conversation and what the chat is
 * running — both work off one shape.
 */
function parsed(line: string): RecordLine | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  try {
    const row = JSON.parse(trimmed) as unknown;
    return row !== null && typeof row === 'object' ? (row as RecordLine) : null;
  } catch {
    return null; // Half a line, or something the kit writes that is not JSON.
  }
}

/**
 * The kit's own word for a message it wrote with no model behind it — an
 * interruption, a refusal it composed itself. Drawn as the model this chat runs
 * it would be a lie, and there are 391 such lines in the manager's records
 * (measured 2026-08-21 over 1,063 of them).
 */
const NO_MODEL_BEHIND_IT = '<synthetic>';

/**
 * What one line says about what the chat is running, folded into `into`.
 *
 * Last one wins on each field, because the record is written by appending and
 * the last thing it says on a subject is what is true now.
 *
 * The mode is taken from any line carrying one: the kit writes a line of its
 * own — `{"type":"permission-mode","permissionMode":…}` — every time the mode
 * changes, and stamps the mode onto the prompts a person types as well. Both
 * are that mode at that moment, so both count.
 *
 * The model is taken only from a reply in THIS conversation. A helper the chat
 * sent off answers on a model of its own, on a sidechain line, and that is the
 * helper's model and not the chat's.
 */
function sipRunning(line: string, into: Running): void {
  const row = parsed(line);
  if (row === null) return;
  if (typeof row.permissionMode === 'string' && row.permissionMode !== '') {
    into.permissionMode = row.permissionMode;
  }
  if (row.type !== 'assistant' || row.isSidechain === true) return;
  const said = row.message;
  if (said === null || typeof said !== 'object') return;
  const model = (said as { model?: unknown }).model;
  if (typeof model === 'string' && model !== '' && model !== NO_MODEL_BEHIND_IT) into.model = model;
}
