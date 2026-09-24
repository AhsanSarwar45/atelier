/**
 * File chips put into text that has already been coloured.
 *
 * A message is markdown and gets its chips while it is still a tree
 * (`mentions.ts`). A tool's command and its output are not: they are painted by
 * highlight.js into a string of HTML and handed to the page as one lump. That
 * is where the addresses actually are — every command a coding agent runs opens
 * `cd /home/…/worktrees/… && …` — so the chips have to go into the string
 * (bw-khe.13).
 *
 * Only the words BETWEEN tags are rewritten. Inside `<span class="hljs-…">` is
 * markup, not writing, and a chip put there would be a broken tag rather than a
 * link. Everything written back out is escaped again, so a command containing
 * `&&` or a `<` is still the command it was.
 */
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { PathPiece } from '@/workbench/paths';

/** A tag, or the words between two of them. */
const TAG = /<[^>]*>/g;

const ESCAPES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&nbsp;': ' ',
};

/** Painted HTML back into the characters someone typed. */
export function unescapeHtml(html: string): string {
  return html.replace(/&(?:amp|lt|gt|quot|nbsp|#39|#x27);/g, (e) => ESCAPES[e] ?? e);
}

/** Characters back into HTML that draws them and nothing else. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The same HTML with every file named in it wrapped in a chip.
 *
 * `split` is the same one the prose uses, so a name that is not a real file is
 * left exactly as it was found — including its colouring, because a run with
 * nothing in it is handed back untouched rather than rebuilt.
 */
export function chipsInHtml(html: string, split: (text: string) => PathPiece[]): string {
  let out = '';
  let from = 0;
  let m: RegExpExecArray | null;
  const scan = new RegExp(TAG.source, TAG.flags);

  while ((m = scan.exec(html)) !== null) {
    out += chipsInRun(html.slice(from, m.index), split);
    out += m[0];
    from = m.index + m[0].length;
  }
  out += chipsInRun(html.slice(from), split);
  return out;
}

function chipsInRun(run: string, split: (text: string) => PathPiece[]): string {
  if (run === '') return '';
  const text = unescapeHtml(run);
  const pieces = split(text);
  if (pieces.length === 1 && pieces[0]!.kind === 'text') return run;

  let out = '';
  for (const piece of pieces) {
    if (piece.kind === 'text') {
      out += escapeHtml(piece.text);
      continue;
    }
    const line = piece.line === null ? '' : ` data-path-line="${piece.line}"`;
    out +=
      `<button type="button" data-slot="button" data-path-mention="${escapeHtml(piece.absolute)}"${line}` +
      ` data-testid="path-chip" data-path-look="link"` +
      ` class="${escapeHtml(CHIP_BUTTON.className)}" title="${escapeHtml(TITLE(piece.line))}">` +
      `${escapeHtml(piece.raw)}</button>`;
  }
  return out;
}

/**
 * How a chip looks. Held here as a plain string because half of them are built
 * into HTML rather than drawn as a component, and both halves must look alike.
 *
 * Underlined rather than coloured: this text is dense, and a hundred bright
 * addresses in a transcript would be a transcript nobody can read.
 */
export const CHIP_CLASS =
  'cursor-pointer underline decoration-dotted underline-offset-2 ' +
  'decoration-muted-foreground/50 hover:decoration-foreground hover:text-foreground';

/**
 * The library's link `Button` a chip is, where there is room for a button: a
 * word in the colour and type of the line, with the chip's dotted underline.
 * `props` is what `PathChip` hands the component; `className` is the same
 * button spelled into HTML, for the chips built into a painted string, where
 * no component can be drawn (bw-weih.5).
 */
const CHIP_BUTTON_PROPS = { mode: 'link', variant: 'inverse', underlined: 'solid', size: 'inherit' } as const;
export const CHIP_BUTTON = {
  props: CHIP_BUTTON_PROPS,
  className: cn(buttonVariants(CHIP_BUTTON_PROPS), CHIP_CLASS),
};

/**
 * What the reader is told a chip does, before they risk clicking it — including
 * the two ways out of the app, which are the whole reason a plain click no
 * longer takes one (bw-g3o3.9).
 */
export const TITLE = (line: number | null): string =>
  line === null
    ? 'Open file · Alt-click for editor · Right-click for options'
    : `Open line ${line} · Alt-click for editor · Right-click for options`;
