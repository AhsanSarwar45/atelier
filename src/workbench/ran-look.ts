/**
 * What each kind of thing an agent does looks like: its mark and its colour.
 *
 * Split from the rules next door for the same reason the machine lines are
 * split (`machine-look.ts`): `said-what-it-ran.ts` imports nothing at run time,
 * so a plain node script can read the real rules without dragging React and
 * lucide in behind them. Which kind a command lands in is decided there; this
 * file only says how that kind is drawn.
 *
 * Seventeen marks, eight colours. The mark is what tells the kinds apart — one
 * per kind, none repeated — and the colour is a band the kind sits in, so a
 * reader scrolling a long chat sees red where something was deleted and grey
 * where the agent was only looking around.
 *
 * Eight is not a rounding. It is every colour the app's ten skins agree on and
 * a reader can still tell apart, counted: `--status-open` is `--info` in all
 * ten of them, `--status-review` is `--epic`, `--status-progress` is
 * `--warning`, `--status-closed` is `--success`, every `--progress-*` doubles
 * one of those in at least one skin, `--chart-*` and `--status-manager` are
 * missing from some skins entirely, and `--blocked-accent` is exactly
 * `--danger` in neo-brutalist, soft-light and notion-warm — which would have
 * drawn a fetched page in the same red as a deleted file. Seventeen hues on a
 * twelve-pixel mark would not be readable even if the skins had them.
 *
 * The classes are written out one band at a time and never built from the
 * band's name: Tailwind ships a class only when it read the literal string in
 * the source, which is exactly how the board's own state colours went grey
 * (src/lib/state-styles.ts, bw-ufso.2). `__tests__/ran-look.test.tsx` runs the
 * real Tailwind over the real tree and fails if one stops coming out.
 */
import {
  Bot,
  Cog,
  Database,
  FileText,
  FlaskConical,
  GitBranch,
  Globe,
  Hammer,
  Hourglass,
  Network,
  Pencil,
  ScrollText,
  Search,
  SpellCheck,
  SquareKanban,
  Terminal,
  Trash2,
  type LucideIcon,
} from 'lucide-react';

import type { RanKind } from '@/workbench/said-what-it-ran';

/**
 * The eight bands, loudest first.
 *
 * The order is the order a reader's eye should find them in: something was
 * deleted, a gate ran, the code changed, the board moved, the history moved,
 * and then the three quiet ones — looking, running, and the machine's own
 * plumbing. Fifty-five of every hundred rows are those last three, which is
 * why they are grey rather than a colour competing with the delete.
 */
export type RanBand =
  | 'deleting'
  | 'gates'
  | 'changing'
  | 'board'
  | 'history'
  | 'looking'
  | 'running'
  | 'plumbing';

export const RAN_BANDS: RanBand[] = [
  'deleting',
  'gates',
  'changing',
  'board',
  'history',
  'looking',
  'running',
  'plumbing',
];

/** The colour of a band. Spelled out, never interpolated — see the note above. */
const BAND_COLOUR: Record<RanBand, string> = {
  deleting: 'text-danger',
  gates: 'text-warning',
  changing: 'text-success',
  board: 'text-epic',
  history: 'text-info',
  looking: 'text-t-secondary',
  running: 'text-t-tertiary',
  plumbing: 'text-t-muted',
};

/** Which band each kind sits in. */
const BAND_OF: Record<RanKind, RanBand> = {
  grave: 'deleting',
  build: 'gates',
  test: 'gates',
  lint: 'gates',
  edit: 'changing',
  board: 'board',
  vcs: 'history',
  read: 'looking',
  search: 'looking',
  // Fetching a page and grepping a folder are the same act to a reader: the
  // agent went and got something and changed nothing.
  web: 'looking',
  net: 'looking',
  run: 'running',
  script: 'running',
  wait: 'running',
  // A helper sent off is work running somewhere else, and it is the only kind
  // whose row keeps moving after it is drawn.
  agent: 'running',
  system: 'plumbing',
  data: 'plumbing',
};

export interface RanLook {
  /** Which of the eight this kind sits in, for the row to carry and be read by. */
  band: RanBand;
  /** The colour of the mark. */
  mark: string;
}

export const lookOfRan = (kind: RanKind): RanLook => ({
  band: BAND_OF[kind],
  mark: BAND_COLOUR[BAND_OF[kind]],
});

/** The colour of a band on its own, for anything drawn beside a row. */
export const colourOfBand = (band: RanBand): string => BAND_COLOUR[band];

/**
 * The mark for each kind. One apiece, never repeated, so the kinds tell
 * themselves apart without the colour and a reader who cannot see the
 * difference between amber and green still reads the row.
 */
const MARKS: Record<RanKind, LucideIcon> = {
  board: SquareKanban,
  vcs: GitBranch,
  search: Search,
  read: FileText,
  edit: Pencil,
  build: Hammer,
  test: FlaskConical,
  lint: SpellCheck,
  run: Terminal,
  net: Network,
  system: Cog,
  data: Database,
  wait: Hourglass,
  script: ScrollText,
  agent: Bot,
  web: Globe,
  grave: Trash2,
};

export const markOfRan = (kind: RanKind): LucideIcon => MARKS[kind];
