/**
 * What is filling a chat's window RIGHT NOW, piece by piece.
 *
 * The gauge on the chat's line says how full the window is; this says what is
 * in it. The two questions a reader actually has are "why is it full" and
 * "what could I take out", and neither is answerable from a number: a chat
 * sitting at 130k might be 100k of conversation, or 30k of conversation under
 * 60k of tools it will never call and three memory files nobody remembers
 * writing (bw-3ug7).
 *
 * Only the kit can answer it. The record on disk holds what each turn COST,
 * not what the prompt of the next one will be MADE OF — the system prompt, the
 * tool schemas, the skills, the memory files are never written into it. So a
 * chat this app is driving can be asked, down the channel that is already open
 * and without taking a turn or spending a token (measured 2026-08-20: 1.4s,
 * 0 tokens), and a chat found on disk is told plainly that it cannot be asked
 * rather than shown a figure worked out here from a guess (decision 13).
 *
 * Shared: the sidecar normalises the kit's answer with this and the browser
 * draws what comes out. It therefore imports types and nothing else — the
 * sidecar runs it through Node's strip-only TypeScript.
 */
import type { TaskSpend } from './token-picture';

/* ------------------------------------------------------------------ *
 * What the kit hands back.
 * ------------------------------------------------------------------ */

/** One band of the window, as the kit names it. */
interface RawCategory {
  name?: unknown;
  tokens?: unknown;
  /** There but not loaded: tools the kit will fetch only if it needs them. */
  isDeferred?: unknown;
}

/**
 * As much of the kit's context answer as this reads.
 *
 * Loose on purpose, like `plan-usage.ts`: this is a control-channel answer
 * whose published type already differs between builds — `systemTools` and
 * `systemPromptSections` are absent from the one measured here — and a shape
 * declared tighter than the kit promises is a lie the compiler enforces.
 */
export interface RawWindowNow {
  categories?: RawCategory[];
  totalTokens?: unknown;
  maxTokens?: unknown;
  rawMaxTokens?: unknown;
  percentage?: unknown;
  model?: unknown;
  memoryFiles?: { path?: unknown; type?: unknown; tokens?: unknown }[];
  mcpTools?: { name?: unknown; serverName?: unknown; tokens?: unknown; isLoaded?: unknown }[];
  autoCompactThreshold?: unknown;
  isAutoCompactEnabled?: unknown;
  messageBreakdown?: {
    toolCallTokens?: unknown;
    toolResultTokens?: unknown;
    attachmentTokens?: unknown;
    assistantMessageTokens?: unknown;
    userMessageTokens?: unknown;
    redirectedContextTokens?: unknown;
    unattributedTokens?: unknown;
    toolCallsByType?: { name?: unknown; callTokens?: unknown; resultTokens?: unknown }[];
    attachmentsByType?: { name?: unknown; tokens?: unknown }[];
  };
}

/* ------------------------------------------------------------------ *
 * What the browser draws.
 * ------------------------------------------------------------------ */

/** One band of the window: what it is, what it costs, how much of the window that is. */
export interface WindowPiece {
  name: string;
  tokens: number;
  /** Of the whole window, so a bar can be drawn straight off it. */
  share: number;
}

/** One named thing that can be pointed at and taken out. */
export interface Weight {
  name: string;
  tokens: number;
}

/**
 * What the conversation itself is made of, as the kit measures it.
 *
 * Its own arithmetic, and it does NOT add up to the conversation band above:
 * the kit counts these by walking the messages and the band by measuring the
 * prompt, and on a fresh chat here the parts came to 6,587 against a band of
 * 4,504 (measured 2026-08-20). So `total` is the parts added — what a share of
 * THIS list means — and never the band's figure.
 */
export interface Inside {
  /** What the model wrote. */
  written: number;
  /** What the human typed. */
  typed: number;
  /** The calls it made. */
  calls: number;
  /** What those calls came back with — usually the biggest of them. */
  answers: number;
  /** Pictures, pasted files, and everything the machinery pushes in. */
  attachments: number;
  /** Context carried over from somewhere else. */
  carried: number;
  /** The rest, which the kit could not attribute. */
  rest: number;
  /** The seven added: what a share of the lists below is measured against. */
  total: number;
  /** Which tools cost the most, call and answer together, biggest first. */
  byTool: Weight[];
  /** Which kinds of attachment cost the most, biggest first. */
  byAttachment: Weight[];
}

/** One server's tools, folded into a row a reader can act on. */
export interface ServerWeight extends Weight {
  /** How many tools it offers. */
  tools: number;
  /** How many of them are loaded rather than waiting to be fetched. */
  loaded: number;
}

/** The whole window, as the kit has it this instant. */
export interface WindowNow {
  /** What is answering, in the kit's own words — it names the long-window builds. */
  model: string | null;
  /** How much of the window is filled. */
  used: number;
  /** How big the window is. */
  window: number;
  /** What is left: the window less what is filled, buffer included. */
  free: number;
  /** The kit's own percentage, which is what its `/context` prints. */
  percent: number;
  /**
   * Where the chat will forget itself: the fullness the kit compacts at, when
   * it is set to. Null when compacting is off, and the chat simply stops.
   */
  forgetsAt: number | null;
  /** The bands that are filled, biggest first. */
  pieces: WindowPiece[];
  /** The bands that are not: free space, and the room kept for compacting. */
  spare: WindowPiece[];
  /** Tools that cost nothing until they are wanted. Not part of `used`. */
  waiting: WindowPiece[];
  /** What the conversation band is made of, when the kit says. */
  inside: Inside | null;
  /** Every memory file in the prompt, biggest first. */
  memory: Weight[];
  /** Every MCP server's tools, folded to one row each, biggest first. */
  servers: ServerWeight[];
}

/**
 * Both halves of the token picture, for one chat.
 *
 * The window is NOW and the spend is EVER, and the reader needs both in front
 * of each other: the gauge drops back to nothing every time the chat forgets
 * itself, and without the second number a day's work looks like it cost 20k.
 * Either half can be missing, and when one is it says so in words a manager
 * can read rather than arriving as a null the screen has to invent a reason
 * for.
 */
export interface TokenPicture {
  window: WindowNow | null;
  /** Why the window is missing. Null when it is not. */
  windowNote: string | null;
  spent: TaskSpend | null;
  /** Why the spend is missing. Null when it is not. */
  spentNote: string | null;
}

/** Said of a chat nobody here is driving — the honest answer, not a guess. */
export const NOT_OURS_TO_ASK =
  'Context details are unavailable for archived chats.';

/* ------------------------------------------------------------------ *
 * Reading one into the other.
 * ------------------------------------------------------------------ */

const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
const text = (s: unknown): string => (typeof s === 'string' ? s : '');

/**
 * The two bands that are room rather than content.
 *
 * Named, because the kit marks the deferred ones with a flag and these with
 * nothing: they are ordinary categories whose meaning is in their name. A
 * build that renames them puts them among the filled bands, which reads wrong
 * but states nothing false — the totals below come from the kit's own figures
 * and not from adding these up.
 */
const ROOM = /^(free space|autocompact buffer)$/i;

const biggestFirst = <T extends { tokens: number }>(rows: T[]): T[] =>
  rows.slice().sort((a, b) => b.tokens - a.tokens);

function insideOf(raw: RawWindowNow['messageBreakdown']): Inside | null {
  if (!raw || typeof raw !== 'object') return null;
  const written = num(raw.assistantMessageTokens);
  const typed = num(raw.userMessageTokens);
  const calls = num(raw.toolCallTokens);
  const answers = num(raw.toolResultTokens);
  const attachments = num(raw.attachmentTokens);
  const carried = num(raw.redirectedContextTokens);
  const rest = num(raw.unattributedTokens);
  const total = written + typed + calls + answers + attachments + carried + rest;
  if (total === 0) return null; // A chat with nothing in it yet says nothing.
  return {
    written,
    typed,
    calls,
    answers,
    attachments,
    carried,
    rest,
    total,
    byTool: biggestFirst(
      (Array.isArray(raw.toolCallsByType) ? raw.toolCallsByType : []).map((row) => ({
        name: text(row?.name) || 'unnamed',
        // What the call and what it came back with, together: a reader taking
        // a tool out of its day loses both, and they are one decision.
        tokens: num(row?.callTokens) + num(row?.resultTokens),
      })),
    ),
    byAttachment: biggestFirst(
      (Array.isArray(raw.attachmentsByType) ? raw.attachmentsByType : []).map((row) => ({
        name: text(row?.name) || 'unnamed',
        tokens: num(row?.tokens),
      })),
    ),
  };
}

/** Every MCP server's tools folded to one row: a server is what a reader turns off. */
function serversIn(raw: RawWindowNow['mcpTools']): ServerWeight[] {
  const byServer = new Map<string, ServerWeight>();
  for (const tool of Array.isArray(raw) ? raw : []) {
    const name = text(tool?.serverName) || 'unnamed';
    const row = byServer.get(name) ?? { name, tokens: 0, tools: 0, loaded: 0 };
    byServer.set(name, {
      name,
      tokens: row.tokens + num(tool?.tokens),
      tools: row.tools + 1,
      loaded: row.loaded + (tool?.isLoaded === true ? 1 : 0),
    });
  }
  return biggestFirst(Array.from(byServer.values()));
}

/**
 * The kit's answer in the browser's shape.
 *
 * Every figure that can be taken from the kit is taken from the kit — what is
 * filled, how big the window is, the percentage — and nothing is re-derived by
 * adding the bands up, because the bands and the totals are two different
 * measurements and a disagreement between them belongs on the screen rather
 * than hidden by preferring one. Null when the answer carries no window at
 * all, which is not a shape this can say anything about.
 */
export function readWindow(raw: RawWindowNow | null | undefined): WindowNow | null {
  if (!raw || typeof raw !== 'object') return null;
  const window = num(raw.rawMaxTokens) || num(raw.maxTokens);
  if (window <= 0) return null;
  const used = num(raw.totalTokens);
  const share = (tokens: number): number => tokens / window;

  const pieces: WindowPiece[] = [];
  const spare: WindowPiece[] = [];
  const waiting: WindowPiece[] = [];
  for (const band of Array.isArray(raw.categories) ? raw.categories : []) {
    const piece = { name: text(band?.name) || 'unnamed', tokens: num(band?.tokens), share: share(num(band?.tokens)) };
    if (piece.tokens <= 0) continue;
    if (band?.isDeferred === true) waiting.push(piece);
    else if (ROOM.test(piece.name)) spare.push(piece);
    else pieces.push(piece);
  }

  return {
    model: text(raw.model) || null,
    used,
    window,
    free: Math.max(0, window - used),
    // The kit's own rounding, so this and its `/context` never disagree by one.
    percent: num(raw.percentage),
    forgetsAt: raw.isAutoCompactEnabled === true && num(raw.autoCompactThreshold) > 0 ? num(raw.autoCompactThreshold) : null,
    pieces: biggestFirst(pieces),
    spare: biggestFirst(spare),
    waiting: biggestFirst(waiting),
    inside: insideOf(raw.messageBreakdown),
    memory: biggestFirst(
      (Array.isArray(raw.memoryFiles) ? raw.memoryFiles : []).map((file) => ({
        name: text(file?.path) || 'unnamed',
        tokens: num(file?.tokens),
      })),
    ),
    servers: serversIn(raw.mcpTools),
  };
}
