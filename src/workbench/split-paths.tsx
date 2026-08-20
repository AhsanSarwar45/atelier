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
export function Chipped({ text }: { text: string }) {
  const split = useContext(SplitPaths);
  const pieces = split(text);
  if (pieces.length === 1 && pieces[0]!.kind === 'text') return <>{text}</>;
  return (
    <>
      {pieces.map((piece, i) =>
        piece.kind === 'text' ? (
          <span key={i}>{piece.text}</span>
        ) : (
          <PathChip key={i} absolute={piece.absolute} raw={piece.raw} line={piece.line} />
        ),
      )}
    </>
  );
}
