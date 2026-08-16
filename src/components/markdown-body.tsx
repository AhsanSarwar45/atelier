/**
 * The one part in this app that turns written text into a page.
 *
 * Card fields and chat messages both come through here, so a heading, a table,
 * a fenced block or an address looks the same wherever it was written. There is
 * no second renderer; a place that needs different spacing passes `tight`.
 */
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import "highlight.js/styles/github-dark.css";

import { cn } from "@/lib/utils";

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

export function MarkdownBody({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn(PROSE_CLASSES, className)}>
      <ReactMarkdown
        // GitHub's own additions, because that is the dialect agents and card
        // fields are written in: tables, task lists, strikethrough, and a bare
        // address becoming a link without anyone having to bracket it.
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          // A link leaves for its own tab and cannot reach back into this one.
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" data-testid="markdown-link" />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
