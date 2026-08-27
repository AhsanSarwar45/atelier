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
import { openLocalPath } from "@/workbench/open-local-path";

/**
 * What a name written in the words should become. Absent — everywhere but a
 * chat — the text is drawn exactly as it always was (bw-4wcd.3).
 */
export interface Mentions {
  /** The text, split into plain words and the things in it that open. */
  split: (text: string) => Piece[];
  card: (id: string) => ReactNode;
  /** A file named in the words, drawn as the reader wrote it (bw-khe.13). */
  path?: (absolute: string, raw: string, line: number | null) => ReactNode;
  /**
   * A whole address, when it names a card or a report of this app's own — drawn
   * as that chip rather than as raw blue text. Nothing, and the address is left
   * the link it already was (bw-8fh2.2).
   */
  link?: (href: string) => ReactNode | null;
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
  // The typography preset draws a backtick of its own before and after every
  // quoted word — the markdown that was already spent making the chip. So a
  // command in a message read `like this`, quote marks and all, while a fenced
  // block (which the preset exempts) read correctly (bw-3ndt.1).
  "prose-code:before:content-none prose-code:after:content-none " +
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

/**
 * Whether the words of a link are the address itself.
 *
 * That is what a pasted address looks like once the markdown dialect has turned
 * it into a link: the words and the destination are the same string, give or
 * take the scheme the dialect fills in for `www.…`. Anything else is a phrase
 * somebody chose.
 */
function wroteItOut(href: string, written: string): boolean {
  const words = written.trim();
  if (!words) return true;
  return words === href || `http://${words}` === href || `https://${words}` === href;
}

/** A path the host can open, rather than an address the browser should visit. */
function localPath(href: string): string | null {
  // A leading slash is also an in-app URL. Limit Unix paths to the locations
  // people can actually link to under the backend's filesystem policy.
  if (/^\/(home|Users)\//.test(href)) return href;
  if (/^[A-Za-z]:[\\/]/.test(href)) return href;
  if (href.startsWith('file://')) {
    try { return decodeURIComponent(new URL(href).pathname); } catch { return null; }
  }
  return null;
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
          // A link leaves for its own tab and cannot reach back into this one —
          // unless it names something of ours, in which case it is a chip, and
          // opens where every other chip opens: inside this window.
          //
          // Only when the writer gave it no words of their own. A bare address
          // is machinery the reader never wanted to see; `[read it](…)` is a
          // sentence somebody wrote, and swapping it for the report's title
          // threw those words away (bw-8fh2.5).
          a: ({ node, ...props }) => {
            const href = String(props.href ?? '');
            const ours = wroteItOut(href, textOf(props.children)) ? mentions?.link?.(href) : null;
            if (ours) return <>{ours}</>;
            const path = localPath(href);
            if (path) return (
              <a
                {...props}
                href={href}
                onClick={(event) => {
                  event.preventDefault();
                  openLocalPath(path);
                }}
                data-testid="markdown-file-link"
              />
            );
            return <a {...props} target="_blank" rel="noopener noreferrer" data-testid="markdown-link" />;
          },
          // A name the rewriting step marked. Everything else drawn as a span
          // stays a span, so nothing about ordinary text changes.
          span: ({ node, ...props }) => {
            const marks = props as Record<string, string | undefined>;
            const card = marks['data-card-mention'];
            if (card && mentions) return <>{mentions.card(card)}</>;
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
