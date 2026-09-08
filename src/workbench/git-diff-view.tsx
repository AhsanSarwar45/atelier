/**
 * What this chat's own worktree has changed, drawn where the transcript sits
 * (bw-rx1y.5).
 *
 * The rail already says WHICH files changed; a person reading "what has this
 * agent done" then wants the lines, and until now that meant leaving the app
 * for a terminal or an editor. So the diff takes the centre of the chat rather
 * than a third column: the rail is 320px and the conversation is the only
 * other thing on the screen worth the width.
 *
 * It is one section per file, collapsible, because a working tree with thirty
 * changed files in it is a list to scan before it is a diff to read — the
 * heading line (name, status, +N −M) is the answer to most questions, and the
 * lines are there for the one file the reader actually cares about.
 *
 * The table is the edit card's table (`diff-table.tsx`), the rows come from the
 * server's hunks through `hunksToRows`, the status chip is the rail's own
 * `STATUS_LOOK`, and the file name is a `PathChip` — the same badge a file
 * named in a message gets, opened by the same one capture listener. Nothing
 * here draws a diff, a chip or a colour of its own.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { ChevronRight } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { git, type GitDiffFile } from '@/lib/api';
import { cn } from '@/lib/utils';
import { languageOf } from '@/workbench/colouring';
import { DiffTable } from '@/workbench/diff-table';
import { gitSaid, STATUS_LOOK } from '@/workbench/git-view';
import { hunksToRows } from '@/workbench/line-diff';
import { openPathClicked, PathChip } from '@/workbench/path-chip';
import { useRepositoryReads } from '@/workbench/use-repository-reads';

/**
 * How many files open themselves, and how long a file may be before it does
 * not.
 *
 * A worktree an agent has been working in all afternoon can carry fifty
 * changed files and tens of thousands of changed lines; drawing every one of
 * them expanded is a page nobody asked for and a browser that stops answering
 * while it lays them out. So the first files open — which is what a reader
 * wants when there are three of them, the common case — and the rest, and any
 * one file long enough to be a document in itself, wait for a click and say so.
 */
const OPEN_AT_MOST = 20;
const LONG_ENOUGH_TO_WAIT = 2_000;

/** The repository-relative path of a file, made absolute for the editor. */
function under(root: string, file: string): string {
  return `${root.replace(/\/+$/, '')}/${file}`;
}

/** One changed file: its heading line, and its lines behind that line's click. */
function FileDiff({
  root,
  file,
  open,
  onFlip,
}: {
  root: string;
  file: GitDiffFile;
  open: boolean;
  onFlip: () => void;
}) {
  const rows = file.binary ? [] : hunksToRows(file.hunks);
  const look = STATUS_LOOK[file.status];
  return (
    <div data-testid="git-diff-file" data-path={file.path} data-open={open} className="flex flex-col gap-1 px-3 py-2">
      {/* The disclosure is the tool row's disclosure: a foreground button that
          is the whole line, with a chevron that turns. The chip inside it is
          not a second button — the container's capture listener answers the
          chip's click and stops it before this button ever hears it, which is
          the same arrangement the transcript's tool rows use (bw-khe.13). */}
      <Button
        type="button"
        variant="foreground"
        size="inherit"
        data-testid="git-diff-file-toggle"
        onClick={onFlip}
        className="w-full justify-start gap-2 rounded-none p-0 text-left enabled:hover:text-foreground"
      >
        <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 truncate">
          <PathChip absolute={under(root, file.path)} raw={file.path} line={1} target="editor" look="badge" />
        </span>
        {file.oldPath && (
          <span className="min-w-0 shrink truncate font-mono text-[11px] text-t-faint">← {file.oldPath}</span>
        )}
        <Badge size="xs" variant={look.tone} appearance="light" aria-hidden="true">
          {look.word}
        </Badge>
        {/* Why a long file starts shut, said on the line where the reader is
            wondering why it is shut. */}
        {!open && rows.length > LONG_ENOUGH_TO_WAIT && (
          <span data-testid="git-diff-long" className="shrink-0 text-[11px] text-t-faint">
            long, click to read
          </span>
        )}
        <span data-testid="git-diff-counts" className="ml-auto shrink-0 tabular-nums font-mono text-[11px]">
          <span className="text-success">+{file.additions}</span>{' '}
          <span className="text-danger">−{file.deletions}</span>
        </span>
      </Button>
      {open && (
        file.binary ? (
          <p data-testid="git-diff-binary" className="pl-5 text-[11px] text-muted-foreground">
            Binary file
          </p>
        ) : rows.length === 0 ? (
          <p data-testid="git-diff-unchanged" className="pl-5 text-[11px] text-muted-foreground">
            Renamed, contents unchanged
          </p>
        ) : (
          /* No height of its own: the column below scrolls, so a long file is
             read by scrolling the page rather than by scrolling a box inside
             a page that also scrolls. */
          <Panel tone="frame" inset="none" className="overflow-hidden">
            {/* The path the table copies with is the repository-relative one
                the chat's own worktree knows this file by, which is the path a
                reference has to carry for the agent to find it again. */}
            <DiffTable rows={rows} language={languageOf(file.path)} path={file.path} />
          </Panel>
        )
      )}
    </div>
  );
}

/** Which files a reader has shut, and which ones started shut. */
function firstShape(files: GitDiffFile[]): Record<string, boolean> {
  const shape: Record<string, boolean> = {};
  files.forEach((file, at) => {
    const rows = file.binary ? 0 : hunksToRows(file.hunks).length;
    shape[file.path] = at < OPEN_AT_MOST && rows <= LONG_ENOUGH_TO_WAIT;
  });
  return shape;
}

export function GitDiffView({ path }: { path: string | null }) {
  const [files, setFiles] = useState<GitDiffFile[] | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  /**
   * Which sections are open, kept by path so that a re-read — and there is one
   * every five seconds — does not throw away what the reader opened or shut.
   * A file the reader has said nothing about is not in here at all, and takes
   * the answer `firstShape` gives it.
   */
  const [said, setSaid] = useState<Record<string, boolean>>({});
  /** What the reader was shown before, so a new file is opened by the rule. */
  const shape = useRef<Record<string, boolean>>({});

  const read = useCallback(
    async (signal?: AbortSignal) => {
      if (!path) return;
      try {
        const answer = await git.diff(path, signal);
        if (signal?.aborted) return;
        shape.current = { ...firstShape(answer.files), ...shape.current };
        setFiles(answer.files);
        setFault(null);
      } catch (trouble) {
        if (signal?.aborted) return;
        setFault(gitSaid(trouble));
      }
    },
    [path],
  );

  // A new worktree is a new diff: nothing the reader said about the old one's
  // files means anything about this one's. (The parent also keys this
  // component on the path, so this is the belt to that's braces.)
  useEffect(() => {
    shape.current = {};
    setSaid({});
    setFiles(null);
    setFault(null);
  }, [path]);

  useEffect(() => {
    const stop = new AbortController();
    void read(stop.signal);
    return () => stop.abort();
  }, [read]);

  const quietly = useCallback(async () => {
    await read();
  }, [read]);
  useRepositoryReads(path, quietly);

  const flip = useCallback((file: string, now: boolean) => {
    setSaid((before) => ({ ...before, [file]: !now }));
  }, []);

  return (
    <div
      data-testid="git-diff-view"
      // One listener for every file badge under it, exactly as the transcript
      // does it: the chip carries the address and this answers the click, so
      // no chip anywhere in the app needs a handler of its own.
      onClickCapture={(event) => openPathClicked(event)}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      {fault && (
        <div className="px-3 py-2">
          {/* git's sentence, wrapped and whole, in the monospace it was written
              in — a path or a sha broken across a line is worse than useless. */}
          <Panel
            tone="danger"
            className="whitespace-pre-wrap break-words font-mono text-[11px] text-danger"
            data-testid="git-diff-error"
          >
            {fault}
          </Panel>
        </div>
      )}
      {/* The first read says nothing at all. It takes a moment on a large
          repository, and a spinner that flashes and goes is more movement than
          news. */}
      {files !== null && files.length === 0 && !fault && (
        <p data-testid="git-diff-empty" className="p-6 text-center text-[12px] text-muted-foreground">
          Nothing has changed
        </p>
      )}
      {(files ?? []).map((file) => {
        const open = said[file.path] ?? shape.current[file.path] ?? true;
        return (
          <FileDiff
            key={file.path}
            root={path ?? ''}
            file={file}
            open={open}
            onFlip={() => flip(file.path, open)}
          />
        );
      })}
    </div>
  );
}
