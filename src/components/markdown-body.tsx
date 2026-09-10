/**
 * The one part in this app that turns written text into a page.
 *
 * Card fields and chat messages both come through here, so a heading, a table,
 * a fenced block or an address looks the same wherever it was written. There is
 * no second renderer; a place that needs different spacing passes `tight`.
 */
import { useState, type ReactNode } from "react";

import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import {
  CircleDot,
  GitCommitHorizontal,
  GitPullRequest,
  Globe2,
  type LucideIcon,
} from "lucide-react";

import "highlight.js/styles/github-dark.css";

import { Badge } from "@/components/ui/badge";
import { FILE_BADGE_CLASS, FILE_KINDS, fileKind } from "@/components/file-kinds";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { rehypeMentions, type Piece } from "@/workbench/mentions";
import { usePathActions } from "@/workbench/path-menu";
import { resolvePath } from "@/workbench/paths";
import { peelLines } from "@/workbench/references";

/**
 * What a name written in the words should become. Absent — everywhere but a
 * chat — the text is drawn exactly as it always was (bw-4wcd.3).
 */
export interface Mentions {
  /** The text, split into plain words and the things in it that open. */
  split: (text: string) => Piece[];
  card: (id: string) => ReactNode;
  /**
   * A file named in the words, drawn as the reader wrote it (bw-khe.13).
   *
   * Everything a message names is a file the same way, fenced blocks and inline
   * code included; the plain link belongs to the rows built out of painted HTML
   * and not to anything here (bw-1e2e.1).
   */
  path?: (
    absolute: string,
    raw: string,
    line: number | null,
    /** The last line, when the words named a range — `@src/a.ts:3-9`. */
    endLine: number | null,
  ) => ReactNode;
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
 * The last line of a marked range — `3-9` is line 9 — or nothing when the span
 * named a single line or none at all (`references.ts`).
 */
function lastLineOf(range: string | undefined): number | null {
  const last = range?.split('-')[1];
  const line = last ? Number(last) : NaN;
  return Number.isFinite(line) ? line : null;
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

interface LocalTarget {
  path: string;
  line: number | null;
}

/**
 * A markdown link that names a file on disk, drawn as the badge every other
 * file in this app is drawn as.
 *
 * It carries the same marks a `PathChip` carries and no handler of its own, so
 * the one set of handlers around the body answers it — the Files tab on a
 * click, the editor on Alt-click, the menu on a right-click (bw-g3o3.9).
 */
function FileLinkBadge({ href, target, children }: {
  href: string;
  target: LocalTarget;
  children: ReactNode;
}) {
  const kind = fileKind(target.path);
  const Icon = FILE_KINDS[kind].icon;
  return (
    <Tooltip label={`Open ${target.path}${target.line === null ? '' : ` at line ${target.line}`}`}>
      <Badge asChild variant="primary" appearance="outline" size="sm" shape="circle" className={cn(FILE_BADGE_CLASS, FILE_KINDS[kind].color)}>
        <a
          href={href}
          data-path-mention={target.path}
          {...(target.line === null ? {} : { 'data-path-line': String(target.line) })}
          data-testid="markdown-file-link"
          data-file-kind={kind}
        >
          <Icon className="mr-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{children}</span>
          {target.line === null ? null : <span className="text-muted-foreground">:{target.line}</span>}
        </a>
      </Badge>
    </Tooltip>
  );
}

type WebKind = 'commit' | 'pull' | 'issue' | 'site';

interface WebTarget {
  kind: WebKind;
  host: string;
  label: string;
  favicon: string;
}

const WEB_KINDS: Record<WebKind, { icon: LucideIcon; color: string; title: string }> = {
  commit: { icon: GitCommitHorizontal, color: 'border-[#e37933]/40 bg-[#e37933]/10 text-[#e37933] hover:bg-[#e37933]/15', title: 'Commit' },
  pull: { icon: GitPullRequest, color: 'border-[#a074c4]/40 bg-[#a074c4]/10 text-[#a074c4] hover:bg-[#a074c4]/15', title: 'Pull request' },
  issue: { icon: CircleDot, color: 'border-[#8dc149]/40 bg-[#8dc149]/10 text-[#8dc149] hover:bg-[#8dc149]/15', title: 'Issue' },
  site: { icon: Globe2, color: 'border-muted-foreground/30 bg-muted/30 text-foreground hover:bg-muted/50', title: 'Website' },
};

function webTarget(href: string): WebTarget | null {
  let url: URL;
  try { url = new URL(href); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(url.hostname)) return null;

  const parts = url.pathname.split('/').filter(Boolean);
  let kind: WebKind = 'site';
  let label = url.hostname.replace(/^www\./, '');
  if (url.hostname === 'github.com' && parts.length >= 4) {
    const [owner, repo, entity, value] = parts;
    if (entity === 'commit') {
      kind = 'commit';
      label = `${owner}/${repo}@${value.slice(0, 7)}`;
    } else if (entity === 'pull' && /^\d+$/.test(value)) {
      kind = 'pull';
      label = `${owner}/${repo} #${value}`;
    } else if (entity === 'issues' && /^\d+$/.test(value)) {
      kind = 'issue';
      label = `${owner}/${repo} #${value}`;
    }
  } else if (url.hostname === 'gitlab.com') {
    const marker = parts.indexOf('-');
    const entity = marker >= 0 ? parts[marker + 1] : '';
    const value = marker >= 0 ? parts[marker + 2] ?? '' : '';
    const repo = marker >= 2 ? `${parts[marker - 2]}/${parts[marker - 1]}` : '';
    if (entity === 'commit') {
      kind = 'commit';
      label = `${repo}@${value.slice(0, 7)}`;
    } else if (entity === 'merge_requests' && /^\d+$/.test(value)) {
      kind = 'pull';
      label = `${repo} !${value}`;
    } else if (entity === 'issues' && /^\d+$/.test(value)) {
      kind = 'issue';
      label = `${repo} #${value}`;
    }
  }
  return { kind, host: url.hostname, label, favicon: `${url.origin}/favicon.ico` };
}

function SiteIcon({ target }: { target: WebTarget }) {
  if (target.kind !== 'site') {
    const Icon = WEB_KINDS[target.kind].icon;
    return <Icon className="mr-0.5 h-3 w-3 shrink-0" aria-hidden="true" />;
  }
  // Keyed on the address so a badge redrawn for a different site starts from
  // the globe again rather than showing the last site's mark while the new one
  // is still on its way.
  return <SiteMark key={target.favicon} favicon={target.favicon} />;
}

/**
 * The globe stands in for a site's own mark until the mark itself arrives, and
 * is then REPLACED by it — one icon on the badge at any moment, always in the
 * same place.
 *
 * The two used to be stacked: a globe and the mark both absolutely placed in a
 * box of their own, so a site that had a mark drew it over the globe rather
 * than in place of it — and drew it a whole line away. An absolutely placed box
 * is still moved by its own margins, and a picture inside a message is written
 * by the typography preset with `2em` of margin above and below (`.prose
 * :where(img)`), which at this text size is about the height of a line: the
 * mark landed off the top-left corner of the pill BELOW its own, over a globe
 * belonging to another site (the manager's report, seven sources in one
 * answer). Swapping one icon for the other cannot overlap, and `my-0` puts the
 * preset's margin back to nothing now that the mark is a box in the line rather
 * than one floating over it.
 *
 * The mark is mounted from the first draw, hidden until it has loaded, because
 * an image that is not in the page fetches nothing: rendering the globe alone
 * and the mark only once loaded would be waiting for a load nobody asked for.
 * `display` is set inline rather than by class or the `hidden` attribute so
 * that no rule of the badge's own can outrank it and reveal a half-loaded mark.
 */
function SiteMark({ favicon }: { favicon: string }) {
  const [mark, setMark] = useState<'waiting' | 'drawn' | 'missing'>('waiting');
  return (
    <>
      {mark === 'drawn' ? null : <Globe2 className="mr-0.5 h-3 w-3 shrink-0" aria-hidden="true" />}
      {mark === 'missing' ? null : (
        <img
          src={favicon}
          alt=""
          aria-hidden="true"
          loading="eager"
          decoding="async"
          referrerPolicy="no-referrer"
          // The same box the globe occupies, down to the pixel the chip's own
          // rule pulls every icon left by (`[&_svg]:-ms-px` in badge.tsx),
          // which reaches svg icons only.
          className="my-0 mr-0.5 -ms-px h-3 w-3 shrink-0 rounded-[2px] object-contain"
          style={mark === 'drawn' ? undefined : { display: 'none' }}
          data-testid="external-favicon"
          onLoad={() => setMark('drawn')}
          onError={() => setMark('missing')}
        />
      )}
    </>
  );
}

function WebLinkBadge({ href, target, children }: { href: string; target: WebTarget; children: ReactNode }) {
  const written = textOf(children);
  const label = wroteItOut(href, written) ? target.label : children;
  const definition = WEB_KINDS[target.kind];
  return (
    <Tooltip label={`Open ${definition.title.toLowerCase()} on ${target.host}`}>
      <Badge asChild variant="primary" appearance="outline" size="sm" shape="circle" className={cn('mx-0.5 align-middle font-mono no-underline', definition.color)}>
        <a href={href} target="_blank" rel="noopener noreferrer" data-testid="markdown-web-badge" data-web-kind={target.kind}>
          <SiteIcon target={target} />
          <span>{label}</span>
        </a>
      </Badge>
    </Tooltip>
  );
}

/**
 * Where a link's own name is on the machine, or null when nothing here can say.
 *
 * A markdown file writes its links the way a person writes them — `./notes.md`,
 * `../src/a.ts`, `docs/guide.md` — and every one of those means "next to me".
 * So a relative name is resolved against the folder the words were read out of,
 * and without that folder it is not an address at all and stays a plain link
 * (bw-ewem.1).
 */
function machinePath(name: string, base?: string): string | null {
  if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name)) return name;
  // A scheme means an address on the web, not a name in somebody's folder.
  if (/^[a-z][a-z0-9+.-]*:/i.test(name)) return null;
  if (!base) return null;
  // No home to hang a `~` on: a markdown file's folder answers `./` and `../`
  // and nothing else. `resolvePath` flattens the result, so `../..` really does
  // walk up before the jail below is asked about where it landed.
  return resolvePath(name, { cwd: base, home: '' });
}

/**
 * A path the host can open, rather than an address the browser should visit.
 *
 * `base` is the folder the words themselves came from, when there is one.
 */
function localTarget(href: string, base?: string): LocalTarget | null {
  // `#installing` alone names a place in THESE words. There is no file in it.
  if (href.startsWith('#')) return null;

  let written: string;
  if (href.startsWith('file://')) {
    try { written = decodeURIComponent(new URL(href).pathname); } catch { return null; }
  } else {
    try { written = decodeURIComponent(href); } catch { return null; }
  }

  // What a link ends in is not part of the name of the file: an agent's
  // citation ends `:42` or `:42:7` — editors only need the line — and a
  // markdown link ends `#L12-L40` or `#installing`. The lines are read by the
  // one grammar that reads them everywhere (`references.ts`); whatever anchor
  // is left is a place inside the file and not a file of its own.
  const { path: named, line } = peelLines(written, { bareHash: false });
  const anchor = named.indexOf('#');
  const name = anchor < 0 ? named : named.slice(0, anchor);
  if (!name) return null;

  const path = machinePath(name, base);
  // A leading slash is also an in-app URL. Limit Unix paths to the locations
  // people can actually link to under the backend's filesystem policy — which
  // is the same rule that stops `../../../../etc/passwd` becoming something
  // this app offers to open, since resolving it lands outside home.
  if (path === null) return null;
  if (!/^\/(home|Users)\//.test(path) && !/^[A-Za-z]:[\\/]/.test(path)) return null;
  return { path, line };
}

/**
 * A browser cannot read an agent's absolute filesystem path directly. Send
 * local pictures through the backend's origin-checked, path-checked media
 * route; the route returns 403/404 for anything the app is not allowed to
 * expose, leaving the image's alt text as the safe failure state.
 */
function localImageSource(src: string, base?: string): string | null {
  const target = localTarget(src, base);
  if (!target || target.line !== null) return null;
  return `/api/fs/media?path=${encodeURIComponent(target.path)}`;
}

export function MarkdownBody({
  children,
  className,
  mentions,
  base,
}: {
  children: string;
  className?: string;
  mentions?: Mentions;
  /**
   * The folder these words were read out of, which is what a link inside them
   * is written against. The Files tab knows it and passes it; a chat message
   * came from nobody's folder and passes nothing, so there only an address
   * written out in full opens, exactly as before (bw-ewem.1).
   */
  base?: string;
}) {
  // Every file named in the words opens the same way, whether the words are a
  // chat message or a card's own field: one set of handlers on the body, and
  // not a handler on each badge inside it (bw-g3o3.9).
  const paths = usePathActions();
  return (
    <>
    <div className={cn(PROSE_CLASSES, className)} {...paths.chips}>
      <ReactMarkdown
        // GitHub's own additions, because that is the dialect agents and card
        // fields are written in: tables, task lists, strikethrough, and a bare
        // address becoming a link without anyone having to bracket it.
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={mentions ? [rehypeHighlight, [rehypeMentions, mentions.split]] : [rehypeHighlight]}
        components={{
          img: ({ node, ...props }) => {
            const src = String(props.src ?? '');
            const local = localImageSource(src, base);
            return (
              <img
                {...props}
                src={local ?? src}
                className={cn('max-h-[70vh] max-w-full rounded-lg object-contain', props.className)}
                data-testid={local ? 'markdown-local-image' : 'markdown-image'}
              />
            );
          },
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
            const local = localTarget(href, base);
            if (local) return (
              <FileLinkBadge href={href} target={local}>
                {props.children}
              </FileLinkBadge>
            );
            const web = webTarget(href);
            if (web) return <WebLinkBadge href={href} target={web}>{props.children}</WebLinkBadge>;
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
              return (
                <>
                  {mentions.path(
                    path,
                    written || path,
                    line ? Number(line) : null,
                    lastLineOf(marks['data-path-range']),
                  )}
                </>
              );
            }
            return <span {...props} />;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
    {/* Outside the prose, which styles its own first and last child. */}
    {paths.menu}
    </>
  );
}
