/**
 * How to find the files named in a run of text, handed down rather than passed.
 *
 * A message gets its chips from the renderer's own `mentions`, but a tool row
 * is drawn several components deep — the row, the body, the line — and its
 * command is where nearly every address in a chat is written. Threading a
 * splitter through all of them would put a prop on parts that have nothing to
 * do with it, so the conversation hands it down and the rows take it where
 * they need it (bw-khe.13).
 *
 * It lives in its own file because both ends need it: the chat provides it, and
 * the rows — held apart from the chat so each redraws alone (bw-uiyz.5) —
 * consume it.
 */
'use client';

import { createContext, useContext } from 'react';

import { paint } from '@/workbench/colouring';
import { PathChip } from '@/workbench/path-chip';
import { chipsInHtml } from '@/workbench/paths-in-html';
import type { PathPiece } from '@/workbench/paths';

/** Outside a chat there is nothing to open, and the default finds nothing. */
export const SplitPaths = createContext<(text: string) => PathPiece[]>((text) => [{ kind: 'text', text }]);

/**
 * The same painted HTML with its addresses chipped, or the same string back
 * when it names none — so a body with no files in it is not rebuilt.
 */
export function withChips(html: string | null, split: (text: string) => PathPiece[]): string | null {
  return html === null ? null : chipsInHtml(html, split);
}

/**
 * A run of plain, uncoloured text drawn with its addresses chipped. Used where
 * there is no language to paint and so no HTML to inject into.
 */
export function Chipped({ text, line, target }: { text: string; line?: number; target?: 'default' | 'editor' }) {
  const split = useContext(SplitPaths);
  const pieces = split(text);
  if (pieces.length === 1 && pieces[0]!.kind === 'text') return <>{text}</>;
  return (
    <>
      {pieces.map((piece, i) =>
        piece.kind === 'text' ? (
          <span key={i}>{piece.text}</span>
        ) : (
          <PathChip key={i} absolute={piece.absolute} raw={piece.raw} line={line ?? piece.line} target={target} />
        ),
      )}
    </>
  );
}

/**
 * One line of code, coloured, inside a cell that carries its own background.
 *
 * Each line lives in its own table cell, so the colour has to arrive already
 * cut into lines. `html` is that cut piece, painted from the whole file so a
 * comment or a string running over several lines stays itself all the way down
 * (bw-4wcd.16); leave it out and the line is painted alone, which is right for
 * a line that never had a file around it.
 *
 * It sits here, beside the splitter it reads, because both the transcript's
 * numbered bodies and the shared diff table draw their lines with it
 * (bw-rx1y.3).
 */
export function Line({ text, language, html }: { text: string; language: string | null; html?: string | null }) {
  const split = useContext(SplitPaths);
  const found = html === undefined ? paint(text, language) : html;
  const painted = found === undefined ? null : withChips(found, split);
  if (painted === null) return <Chipped text={text} />;
  return <span dangerouslySetInnerHTML={{ __html: painted }} />;
}
