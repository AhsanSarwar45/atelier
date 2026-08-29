/**
 * The one part in this app that turns written text into a page.
 *
 * Card fields and chat messages both come through here, so a heading, a table,
 * a fenced block or an address looks the same wherever it was written. There is
 * no second renderer; a place that needs different spacing passes `tight`.
 */
import type { MouseEventHandler, ReactNode } from "react";

import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import {
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  CircleDot,
  GitCommitHorizontal,
  GitPullRequest,
  Globe2,
  type LucideIcon,
} from "lucide-react";

import "highlight.js/styles/github-dark.css";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
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

interface LocalTarget {
  path: string;
  line: number | null;
}

type FileKind = 'archive' | 'audio' | 'code' | 'data' | 'image' | 'table' | 'text' | 'video' | 'file';

const FILE_KINDS: Record<FileKind, { extensions: Set<string>; icon: LucideIcon; color: string }> = {
  archive: { extensions: new Set(['7z', 'bz2', 'gz', 'rar', 'tar', 'tgz', 'xz', 'zip']), icon: FileArchive, color: 'border-[#e37933]/40 bg-[#e37933]/10 text-[#e37933] hover:bg-[#e37933]/15' },
  audio: { extensions: new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav']), icon: FileAudio, color: 'border-[#cbcb41]/40 bg-[#cbcb41]/10 text-[#cbcb41] hover:bg-[#cbcb41]/15' },
  code: { extensions: new Set(['c', 'cc', 'cpp', 'css', 'go', 'h', 'html', 'java', 'js', 'jsx', 'kt', 'php', 'py', 'rb', 'rs', 'sh', 'sql', 'swift', 'ts', 'tsx', 'vue']), icon: FileCode2, color: 'border-[#519aba]/40 bg-[#519aba]/10 text-[#519aba] hover:bg-[#519aba]/15' },
  data: { extensions: new Set(['json', 'jsonl', 'toml', 'xml', 'yaml', 'yml']), icon: FileJson, color: 'border-[#cbcb41]/40 bg-[#cbcb41]/10 text-[#cbcb41] hover:bg-[#cbcb41]/15' },
  image: { extensions: new Set(['avif', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']), icon: FileImage, color: 'border-[#a074c4]/40 bg-[#a074c4]/10 text-[#a074c4] hover:bg-[#a074c4]/15' },
  table: { extensions: new Set(['csv', 'numbers', 'ods', 'tsv', 'xls', 'xlsx']), icon: FileSpreadsheet, color: 'border-[#8dc149]/40 bg-[#8dc149]/10 text-[#8dc149] hover:bg-[#8dc149]/15' },
  text: { extensions: new Set(['log', 'md', 'pdf', 'rtf', 'txt']), icon: FileText, color: 'border-[#6d8086]/40 bg-[#6d8086]/10 text-[#91a3a8] hover:bg-[#6d8086]/15' },
  video: { extensions: new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'webm']), icon: FileVideo, color: 'border-[#e06c75]/40 bg-[#e06c75]/10 text-[#e06c75] hover:bg-[#e06c75]/15' },
  file: { extensions: new Set(), icon: File, color: 'border-muted-foreground/30 bg-muted/30 text-muted-foreground hover:bg-muted/50' },
};

function fileKind(path: string): FileKind {
  const extension = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  return (Object.entries(FILE_KINDS) as [FileKind, (typeof FILE_KINDS)[FileKind]][])
    .find(([kind, definition]) => kind !== 'file' && definition.extensions.has(extension))?.[0] ?? 'file';
}

function FileLinkBadge({ href, target, children, onClick }: {
  href: string;
  target: LocalTarget;
  children: ReactNode;
  onClick: MouseEventHandler<HTMLAnchorElement>;
}) {
  const kind = fileKind(target.path);
  const Icon = FILE_KINDS[kind].icon;
  return (
    <Badge asChild variant="primary" appearance="outline" size="sm" shape="circle" className={cn('mx-0.5 align-middle font-mono no-underline', FILE_KINDS[kind].color)}>
      <a href={href} onClick={onClick} data-testid="markdown-file-link" data-file-kind={kind} title={`Open ${target.path}${target.line === null ? '' : ` at line ${target.line}`}`}>
        <Icon className="mr-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
        <span>{children}</span>
        {target.line === null ? null : <span className="text-muted-foreground">:{target.line}</span>}
      </a>
    </Badge>
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
  return (
    <span className="relative mr-0.5 h-3 w-3 shrink-0" aria-hidden="true">
      <Globe2 className="absolute inset-0 h-3 w-3" />
      <img
        src={target.favicon}
        alt=""
        loading="eager"
        decoding="async"
        referrerPolicy="no-referrer"
        className="absolute inset-0 h-3 w-3 rounded-[2px] object-contain"
        data-testid="external-favicon"
        onError={(event) => { event.currentTarget.hidden = true; }}
      />
    </span>
  );
}

function WebLinkBadge({ href, target, children }: { href: string; target: WebTarget; children: ReactNode }) {
  const written = textOf(children);
  const label = wroteItOut(href, written) ? target.label : children;
  const definition = WEB_KINDS[target.kind];
  return (
    <Badge asChild variant="primary" appearance="outline" size="sm" shape="circle" className={cn('mx-0.5 align-middle font-mono no-underline', definition.color)}>
      <a href={href} target="_blank" rel="noopener noreferrer" data-testid="markdown-web-badge" data-web-kind={target.kind} title={`Open ${definition.title.toLowerCase()} on ${target.host}`}>
        <SiteIcon target={target} />
        <span>{label}</span>
      </a>
    </Badge>
  );
}

/** A path the host can open, rather than an address the browser should visit. */
function localTarget(href: string): LocalTarget | null {
  // A leading slash is also an in-app URL. Limit Unix paths to the locations
  // people can actually link to under the backend's filesystem policy.
  let path: string;
  if (href.startsWith('file://')) {
    try { path = decodeURIComponent(new URL(href).pathname); } catch { return null; }
  } else {
    try { path = decodeURIComponent(href); } catch { return null; }
  }

  if (!/^\/(home|Users)\//.test(path) && !/^[A-Za-z]:[\\/]/.test(path)) return null;

  // Agent file citations conventionally end in :line or :line:column. Keep
  // the column out of the filename too; editors only need the line here.
  const location = path.match(/:(\d+)(?::\d+)?$/);
  if (!location) return { path, line: null };
  return {
    path: path.slice(0, -location[0].length),
    line: Number(location[1]),
  };
}

/**
 * A browser cannot read an agent's absolute filesystem path directly. Send
 * local pictures through the backend's origin-checked, path-checked media
 * route; the route returns 403/404 for anything the app is not allowed to
 * expose, leaving the image's alt text as the safe failure state.
 */
function localImageSource(src: string): string | null {
  const target = localTarget(src);
  if (!target || target.line !== null) return null;
  return `/api/fs/media?path=${encodeURIComponent(target.path)}`;
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
          img: ({ node, ...props }) => {
            const src = String(props.src ?? '');
            const local = localImageSource(src);
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
            const local = localTarget(href);
            if (local) return (
              <FileLinkBadge
                href={href}
                target={local}
                onClick={(event) => {
                  event.preventDefault();
                  openLocalPath(
                    local.path,
                    local.line === null ? 'finder' : 'vscode',
                    local.line,
                  );
                }}
              >
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
