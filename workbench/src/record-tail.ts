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
import { readdirSync, statSync } from 'node:fs';
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
}

/** What one look at the end of the record found. */
export interface Grown {
  /** The lines that have arrived since the last look, in the order written. */
  fresh: RecordLine[];
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
 * The byte the line naming this one begins at, looked for from the END.
 *
 * A whole-record read holds back the rows whose commands have no answers yet,
 * and those lines are the last few of the file. Handing the follower the byte
 * they begin at — rather than the byte the read stopped at, which is past them
 * — is what lets it say where it stands after a beat, and so what lets the
 * NEXT open of a chat that is being written carry on instead of reading the
 * whole record again (bw-uiyz.19).
 *
 * The window starts small and doubles, so the usual case reads a page and the
 * unusual one still finds it. Null when the record, or the line, is not there.
 */
export async function lineBegins(sessionId: string, name: string, config?: string): Promise<number | null> {
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
      const line = found === -1 ? -1 : text.lastIndexOf('\n', found);
      // A hit in the window's first line is only trustworthy when that line is
      // whole — either the window reaches the start of the file, or a newline
      // stands before it.
      if (found !== -1 && (line !== -1 || from === 0)) return from + line + 1;
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
      return { fresh: [], rewritten: false, read: 0 };
    }
    if (size < this.at) {
      this.at = size;
      this.partial = '';
      return { fresh: [], rewritten: true, read: 0 };
    }
    if (size === this.at) return { fresh: [], rewritten: false, read: 0 };

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
    for (const line of lines) {
      const said = readLine(line);
      if (said) fresh.push(said);
    }
    return { fresh, rewritten: false, read: got };
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
  const trimmed = line.trim();
  if (trimmed === '') return null;
  let row: RecordLine;
  try {
    row = JSON.parse(trimmed) as RecordLine;
  } catch {
    return null; // Half a line, or something the kit writes that is not JSON.
  }
  if (row.type !== 'user' && row.type !== 'assistant') return null;
  if (row.isSidechain === true || row.isMeta === true) return null;
  return row;
}
