'use client';

/**
 * Who made a commit, when, and what they said — drawn above its diff
 * (bw-g6zy.5).
 *
 * Three quiet lines and then the message, rather than everything git knows.
 * A header that lists every field a commit carries is a header nobody reads,
 * and the diff below it is what the reader came for. So the committer appears
 * only when it is not the author, which is the one case where the difference
 * means something — a rebase, a cherry-pick, a patch applied from a mailing
 * list — and is silence the rest of the time.
 */

import * as React from 'react';

import { format, formatDistanceToNow } from 'date-fns';
import { Check, Copy, GitCommitHorizontal, GitMerge, Tag } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import type { GitCommitDetail, GitDiffFile } from '@/lib/api';
import { cn } from '@/lib/utils';

/** How many lines of the message are shown before it has to be asked for. */
const LINES_SHOWN = 3;

function whenMade(date: string): { near: string; exact: string } {
  try {
    const at = new Date(date);
    return {
      near: formatDistanceToNow(at, { addSuffix: true }),
      exact: format(at, "d MMMM yyyy 'at' HH:mm"),
    };
  } catch {
    return { near: date, exact: date };
  }
}

/** A decoration git wrote, split into what it points with and what it names. */
function refName(decoration: string): { name: string; tag: boolean; head: boolean } {
  const head = decoration.startsWith('HEAD ->');
  const tag = decoration.startsWith('tag: ');
  return {
    head,
    tag,
    name: decoration
      .replace(/^HEAD ->\s*/, '')
      .replace(/^tag:\s*/, '')
      .replace(/^refs\/(heads|remotes|tags)\//, ''),
  };
}

export interface CommitDetailsProps {
  commit: GitCommitDetail;
  /** What it changed, for the counts along the bottom line. */
  files: GitDiffFile[];
  /** Open another commit — a parent, say. */
  onOpen?: (sha: string) => void;
  /** Leave the commit and go back to the working tree. */
  onLeave?: () => void;
}

export function CommitDetails({ commit, files, onOpen, onLeave }: CommitDetailsProps) {
  const [open, setOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const made = whenMade(commit.date);
  const committed = whenMade(commit.committerDate);
  // git records the two separately and they differ on the byte, not just on
  // the person: a commit rebased an hour later has the same author to the
  // letter and a committer date an hour on. Only the person is worth a line.
  const carried = commit.committer !== commit.author || commit.committerEmail !== commit.email;

  const added = files.reduce((sum, file) => sum + file.additions, 0);
  const removed = files.reduce((sum, file) => sum + file.deletions, 0);

  // The subject is the message's first line, and the rest is the body proper.
  const rest = commit.body.split('\n').slice(1).join('\n').trim();
  const long = rest.split('\n').length > LINES_SHOWN;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(commit.sha);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      // A browser that will not hand over the clipboard is not a failure worth
      // a red panel over a commit header.
    }
  };

  return (
    <div
      className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-4 py-3"
      data-testid="commit-details"
      data-sha={commit.sha}
    >
      <div className="flex items-start gap-2">
        <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-t-tertiary" aria-hidden="true" />
        <h2
          className="min-w-0 flex-1 break-words text-sm font-medium text-t-primary"
          data-testid="commit-subject"
        >
          {commit.subject}
        </h2>
        {onLeave && (
          <Button size="xs" variant="outline" data-testid="commit-leave" onClick={onLeave}>
            Working tree
          </Button>
        )}
      </div>

      {commit.refs.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" data-testid="commit-refs">
          {commit.refs.map((decoration) => {
            const { name, tag, head } = refName(decoration);
            return (
              <Badge
                key={decoration}
                size="sm"
                variant={head ? 'primary' : tag ? 'warning' : 'secondary'}
                appearance="light"
                data-testid="commit-ref"
              >
                {tag && <Tag aria-hidden="true" />}
                {name}
              </Badge>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-t-tertiary">
        <Tooltip label={commit.email}>
          <span className="font-medium text-t-secondary">{commit.author}</span>
        </Tooltip>
        <Tooltip label={made.exact}>
          <span data-testid="commit-when">{made.near}</span>
        </Tooltip>
        <Tooltip label={copied ? 'Copied' : 'Copy the full name'}>
          <Button
            size="xs"
            variant="ghost"
            className="h-5 gap-1 px-1 font-mono text-[10px]"
            data-testid="commit-sha"
            onClick={() => void copy()}
          >
            {commit.shortSha}
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            <span className="sr-only">Copy the full commit name</span>
          </Button>
        </Tooltip>
        {commit.merge && (
          <Badge size="sm" variant="info" appearance="light" data-testid="commit-merge">
            <GitMerge aria-hidden="true" />
            Merge
          </Badge>
        )}
      </div>

      {carried && (
        <p className="text-[11px] text-t-faint" data-testid="commit-committer">
          Committed by {commit.committer}, {committed.near}
        </p>
      )}

      {rest && (
        <div className="flex flex-col items-start gap-1">
          <p
            className={cn(
              'whitespace-pre-wrap break-words text-xs text-t-secondary',
              !open && long && 'line-clamp-3',
            )}
            data-testid="commit-body"
          >
            {rest}
          </p>
          {long && (
            <Button
              size="xs"
              variant="ghost"
              className="h-5 px-1 text-[11px]"
              data-testid="commit-body-more"
              onClick={() => setOpen(!open)}
            >
              {open ? 'Less' : 'More'}
            </Button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-t-tertiary" data-testid="commit-counts">
          {files.length} file{files.length === 1 ? '' : 's'} changed
        </span>
        <span className="font-medium text-success tabular-nums">+{added}</span>
        <span className="font-medium text-danger tabular-nums">−{removed}</span>
        <StatBar added={added} removed={removed} />
        {commit.parents.length > 0 && (
          <span className="ml-auto flex items-center gap-1 text-t-faint">
            {commit.parents.length === 1 ? 'Built on' : 'Merging'}
            {commit.parents.map((parent) => (
              <Button
                key={parent}
                size="xs"
                variant="ghost"
                className="h-5 px-1 font-mono text-[10px]"
                data-testid="commit-parent"
                data-sha={parent}
                onClick={() => onOpen?.(parent)}
              >
                {parent.slice(0, 7)}
              </Button>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The five blocks every git client draws: how much of the change was addition
 * and how much was removal, at a glance.
 */
function StatBar({ added, removed }: { added: number; removed: number }) {
  const total = added + removed;
  const green = total === 0 ? 0 : Math.round((added / total) * 5);
  return (
    <span className="flex items-center gap-px" aria-hidden="true" data-testid="commit-stat-bar">
      {Array.from({ length: 5 }, (_, at) => (
        <span
          key={at}
          className={cn(
            'size-1.5 rounded-[1px]',
            total === 0 ? 'bg-border' : at < green ? 'bg-success' : 'bg-danger',
          )}
        />
      ))}
    </span>
  );
}
