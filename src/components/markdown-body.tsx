/**
 * The one part in this app that turns written text into a page.
 *
 * Card fields and chat messages both come through here, so a heading, a table,
 * a fenced block or an address looks the same wherever it was written. There is
 * no second renderer; a place that needs different spacing passes `tight`.
 */
import type { ReactNode } from "react";

import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import "highlight.js/styles/github-dark.css";

import { cn } from "@/lib/utils";
import { rehypeMentions, type Piece } from "@/workbench/mentions";

/**
 * What a name written in the words should become. Absent — everywhere but a
 * chat — the text is drawn exactly as it always was (bw-4wcd.3).
 */
export interface Mentions {
  /** The text, split into plain words and the things in it that open. */
  split: (text: string) => Piece[];
  card: (id: string) => ReactNode;
  report: (slug: string) => ReactNode;
  /** A file named in the words, drawn as the reader wrote it (bw-khe.13). */
  path?: (absolute: string, raw: string, line: number | null) => ReactNode;
}

const PROSE_CLASSES =
  "prose prose-sm dark:prose-invert max-w-none " +
  // Tighten vertical rhythm: prose-sm defaults are tuned for long-form docs,
  // not the terse bead fields rendered here.
  "prose-p:my-2 prose-headings:mt-3 prose-headings:mb-2 " +
  "prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 " +
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 " +
  "prose-pre:bg-zinc-900 prose-pre:text-zinc-100 " +
  "prose-code:text-sm prose-code:bg-zinc-100 dark:prose-code:bg-zinc-800 " +
  "prose-code:px-1 prose-code:py-0.5 prose-code:rounded " +
  // A pasted path or a long address must not push the column wider than its box.
  "prose-pre:overflow-x-auto break-words";

/**
 * The words inside a marked span — what the reader actually wrote, which is
 * what a chip draws and what a copied command must still contain.
 */
function textOf(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(textOf).join('');
  return '';
}

export function MarkdownBody({
  children,
  className,
  mentions,
}: {
  children: string;
  className?: string;
  mentions?: Mentions;
}) {
  return (
    <div className={cn(PROSE_CLASSES, className)}>
      <ReactMarkdown
        // GitHub's own additions, because that is the dialect agents and card
        // fields are written in: tables, task lists, strikethrough, and a bare
        // address becoming a link without anyone having to bracket it.
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={mentions ? [rehypeHighlight, [rehypeMentions, mentions.split]] : [rehypeHighlight]}
        components={{
          // A link leaves for its own tab and cannot reach back into this one.
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" data-testid="markdown-link" />
          ),
          // A name the rewriting step marked. Everything else drawn as a span
          // stays a span, so nothing about ordinary text changes.
          span: ({ node, ...props }) => {
            const marks = props as Record<string, string | undefined>;
            const card = marks['data-card-mention'];
            if (card && mentions) return <>{mentions.card(card)}</>;
            const report = marks['data-report-mention'];
            if (report && mentions) return <>{mentions.report(report)}</>;
            const path = marks['data-path-mention'];
            if (path && mentions?.path) {
              const line = marks['data-path-line'];
              const written = textOf(props.children);
              return <>{mentions.path(path, written || path, line ? Number(line) : null)}</>;
            }
            return <span {...props} />;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
