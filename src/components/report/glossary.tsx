/**
 * The glossed term: a word the manager might not know, underlined and given
 * its plain meaning on hover — the app's own version of `blocks.py`'s
 * `Ctx.text()`, which wrapped the first occurrence of every glossary term in
 * an `<abbr title=…>`. Reuses the app's own Tooltip rather than a native
 * title attribute, so it looks and behaves like every other hint in the app.
 *
 * Only the first occurrence of a term in a given string is glossed, same as
 * the Python builder — a paragraph that says "epic" three times does not need
 * the same tooltip three times.
 */
'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import type { GlossaryEntry } from './types';

const GlossaryContext = createContext<GlossaryEntry[]>([]);

export function GlossaryProvider({ terms, children }: { terms: GlossaryEntry[]; children: ReactNode }) {
  return <GlossaryContext.Provider value={terms}>{children}</GlossaryContext.Provider>;
}

/** Renders `text` with its first glossed term (if any) turned into a hoverable hint. */
export function Gloss({ text }: { text: string }) {
  const terms = useContext(GlossaryContext);
  const parts = useMemo(() => splitOnFirstTerm(text, terms), [text, terms]);
  if (!parts) return <>{text}</>;
  const { before, term, plain, after } = parts;
  return (
    <>
      {before}
      <Tooltip>
        <TooltipTrigger asChild>
          <abbr className="cursor-help border-b border-dotted border-t-muted text-inherit no-underline">
            {term}
          </abbr>
        </TooltipTrigger>
        <TooltipContent>{plain}</TooltipContent>
      </Tooltip>
      {after}
    </>
  );
}

function splitOnFirstTerm(
  text: string,
  terms: GlossaryEntry[],
): { before: string; term: string; plain: string; after: string } | null {
  let best: { index: number; entry: GlossaryEntry } | null = null;
  for (const entry of terms) {
    if (!entry.term) continue;
    const re = new RegExp(`\\b${escapeRegExp(entry.term)}\\b`);
    const m = re.exec(text);
    if (m && (best === null || m.index < best.index)) {
      best = { index: m.index, entry };
    }
  }
  if (!best) return null;
  return {
    before: text.slice(0, best.index),
    term: text.slice(best.index, best.index + best.entry.term.length),
    plain: best.entry.plain,
    after: text.slice(best.index + best.entry.term.length),
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
