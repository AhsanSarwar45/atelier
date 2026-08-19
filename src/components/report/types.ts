/**
 * The manager-report contract: what `GET /api/reports/spec` hands back, typed.
 *
 * This mirrors `reporting/tools/blocks.py` (the shelf) and `build.py` (the six
 * slots) field for field — those two files are the authority on what exists;
 * this file only gives it TypeScript shape. Nothing here should say more than
 * they do, and a field added there without a match here is a bug in this file,
 * not in them.
 */

/** The seven colours a block may be tinted. `grey` is the one with no accent — it reads as muted text, not a hue. */
export type Tone = 'grey' | 'blue' | 'green' | 'amber' | 'red' | 'violet' | 'teal';

/** The four tones a `note` block may take — a separate, smaller vocabulary from `Tone`. */
export type NoteTone = 'info' | 'good' | 'warn' | 'bad';

/** The two special row states `rows` may mark — also not part of `Tone`. */
export type RowTone = 'hot' | 'gone';

/** How expensive a step in the Next slot is, coarse enough to be honest about. */
export type Cost = 'tiny' | 'small' | 'medium' | 'large';

/** A checklist item's state in the "Where we are" part. */
export type ChecklistState = 'done' | 'draft' | 'todo';

/** The board card a question or checklist item resolves to, already looked up server-side. */
export interface ReportCard {
  id: string;
  title: string;
  status: string;
  column: string;
}

export interface QuestionOption {
  label: string;
  /** What gets typed into the reply when this option is picked. Falls back to the label if absent. */
  say?: string | null;
  /** Exactly one option per question carries this — the recommended answer. */
  pick?: boolean;
}

export interface ReportQuestion {
  id: string;
  ask: string;
  options: QuestionOption[];
  note?: string | null;
  /** The card id this question is holding up. It leaves the page when that card closes. */
  holds: string;
  live: boolean;
  card: ReportCard | null;
}

export interface ReportActions {
  /** True for an FYI report — no question is waiting on an answer. */
  none: boolean;
  fyi?: string | null;
  questions: ReportQuestion[];
}

export interface StatusItem {
  state: ChecklistState;
  text: string;
  tag?: string | null;
  card?: string | null;
}

export interface ReportStatus {
  /** Set when the checklist is driven by a board card rather than typed by hand. */
  card?: string | null;
  now: string | null;
  next_up: string | null;
  items: StatusItem[];
}

/* ── the block shelf — one entry per kind in reporting/tools/blocks.py ── */

export interface TextBlock {
  kind: 'text';
  text: string;
}

export interface ListBlock {
  kind: 'list';
  items: string[];
  ordered?: boolean;
}

export interface RowsRow {
  n?: string;
  title: string;
  note?: string | null;
  tone?: RowTone;
}

export interface RowsBlock {
  kind: 'rows';
  rows: RowsRow[];
}

export interface NoteBlock {
  kind: 'note';
  tone?: NoteTone;
  label?: string | null;
  text: string;
}

/** A table cell: plain text/number, or one of the three typed shapes blocks.py's `_cell` accepts. */
export type TableCell =
  | string
  | number
  | { pill: string; tone?: Tone }
  | { num: string | number }
  | { bold: string };

export type TableColumn = string | { name: string; align?: 'text' | 'right' | 'num' };

export interface TableBlock {
  kind: 'table';
  columns: TableColumn[];
  rows: TableCell[][];
}

export interface Tile {
  key: string;
  value: string | number;
  tone?: Tone;
  delta?: string | null;
}

export interface TilesBlock {
  kind: 'tiles';
  tiles: Tile[];
}

export interface BarSeries {
  label: string;
  value: number;
  tone?: Tone;
}

export interface BarsBlock {
  kind: 'bars';
  series: BarSeries[];
  unit?: string;
  alt?: string;
}

export interface BreakdownPart {
  label: string;
  value: number;
  tone?: Tone;
}

export interface BreakdownBlock {
  kind: 'breakdown';
  parts: BreakdownPart[];
  unit?: string;
  alt?: string;
}

export interface TrendLine {
  label: string;
  values: number[];
  tone?: Tone;
}

export interface TrendBlock {
  kind: 'trend';
  x: (string | number)[];
  lines: TrendLine[];
  unit?: string;
  alt?: string;
}

/** An image, already resolved to a data URI or plain URL by the server — never a local `path`. */
export interface Shot {
  src: string;
  caption?: string | null;
}

export interface ImagesBlock {
  kind: 'images';
  shots: Shot[];
}

export interface CompareBlock {
  kind: 'compare';
  before: Shot;
  after: Shot;
}

export interface WipeBlock {
  kind: 'wipe';
  before: Shot;
  after: Shot;
}

export type Block =
  | TextBlock
  | ListBlock
  | RowsBlock
  | NoteBlock
  | TableBlock
  | TilesBlock
  | BarsBlock
  | BreakdownBlock
  | TrendBlock
  | ImagesBlock
  | CompareBlock
  | WipeBlock;

export type BlockKind = Block['kind'];

export interface ContentSection {
  id: string;
  label: string;
  lead?: string | null;
  blocks: Block[];
}

export interface Decision {
  id: string;
  title: string;
  why: string;
  tag?: string | null;
  needs_you: boolean;
}

export interface NextStep {
  step: string;
  cost: Cost;
  starting?: boolean;
}

export interface NextSlot {
  if_nothing: string;
  steps: NextStep[];
}

export interface GlossaryEntry {
  term: string;
  plain: string;
}

export interface ReportWarning {
  kind: string;
  term: string;
  instead: string;
  where: string;
}

export interface BoardInfo {
  reachable: boolean;
  why: string | null;
}

/** The whole document, as `GET /api/reports/spec?project&slug&path` returns it. */
export interface ReportSpec {
  slug: string;
  project: string;
  title: string;
  eyebrow?: string | null;
  actions: ReportActions;
  status: ReportStatus;
  content: ContentSection[];
  decisions: Decision[];
  next: NextSlot;
  glossary: GlossaryEntry[];
  warnings: ReportWarning[];
  built_at: string;
  board: BoardInfo;
}
