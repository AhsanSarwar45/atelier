'use client';

/**
 * The history, searched and opened (bw-g6zy.4, bw-g6zy.5).
 *
 * This used to be twenty list items at the bottom of one long column, with no
 * way to search them and no way to press one. It is now the lower pane of the
 * Git rail: a search line, the commits that answer it, and more of them as the
 * list is scrolled.
 *
 * Every filter is answered by git rather than by sieving the commits already
 * in hand, so the search reaches the whole history and not only the page that
 * happens to be on screen. What that costs is a round trip per keystroke,
 * which is why the typing settles before anything is asked for.
 */

import * as React from 'react';

import { formatDistanceToNow } from 'date-fns';
import { GitMerge, Tag } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { git, type GitCommit } from '@/lib/api';
import { cn } from '@/lib/utils';
import { asLogQuery, isEmpty, readQuery } from '@/workbench/commit-query';
import { CommitSearch } from '@/workbench/commit-search';
import { useRepositoryReads } from '@/workbench/use-repository-reads';

/** How many commits one read asks for. */
export const PAGE = 30;

/**
 * How long typing has to stop before the history is asked (ms).
 *
 * Long enough that a word typed at speed is one question and not eight, short
 * enough that the answer is already arriving by the time the eye leaves the
 * box.
 */
const SETTLES_MS = 250;

/** How long ago, in words, falling back to the stamp if it cannot be read. */
function whenMade(date: string): string {
  try {
    return formatDistanceToNow(new Date(date), { addSuffix: true });
  } catch {
    return date;
  }
}

/**
 * A decoration worth drawing, shortened.
 *
 * `HEAD -> main` is two facts in one string and only one of them is a name;
 * `refs/` prefixes are git's own bookkeeping and say nothing a person reading
 * a rail wants to read.
 */
function refName(decoration: string): { name: string; tag: boolean; head: boolean } {
  const head = decoration.startsWith('HEAD ->');
  const tag = decoration.startsWith('tag: ');
  const name = decoration
    .replace(/^HEAD ->\s*/, '')
    .replace(/^tag:\s*/, '')
    .replace(/^refs\/(heads|remotes|tags)\//, '');
  return { name, tag, head };
}

export interface CommitLogProps {
  /** The checkout being read. */
  path: string;
  /** Whether the pane is on screen; a shut rail asks for nothing. */
  shown?: boolean;
  /** The commit currently open in the diff pane, if any. */
  openSha?: string | null;
  /** Open one commit. */
  onOpen?: (commit: GitCommit) => void;
  /** Go back to the working tree, which is what Escape means here. */
  onLeave?: () => void;
}

export function CommitLog({ path, shown = true, openSha, onOpen, onLeave }: CommitLogProps) {
  const [line, setLine] = React.useState('');
  const [asked, setAsked] = React.useState('');
  const [commits, setCommits] = React.useState<GitCommit[]>([]);
  const [reading, setReading] = React.useState(false);
  const [fault, setFault] = React.useState<string | null>(null);
  const [ended, setEnded] = React.useState(false);
  const list = React.useRef<HTMLUListElement>(null);

  // The typing settles before the history is asked. Without this every
  // keystroke is its own `git log` over the whole history, and the answers
  // race each other to the screen.
  React.useEffect(() => {
    const settling = setTimeout(() => setAsked(line), SETTLES_MS);
    return () => clearTimeout(settling);
  }, [line]);

  const query = React.useMemo(() => readQuery(asked), [asked]);

  /**
   * Read the history from the top.
   *
   * `held` keeps whatever has already been paged in: a repository that moved
   * while the reader was twenty commits down should not throw him back to the
   * first page to tell him so.
   */
  const read = React.useCallback(
    async (signal?: AbortSignal, quietly?: boolean) => {
      if (!path || !shown) return;
      const held = Math.max(PAGE, commitsHeld.current);
      if (!quietly) setReading(true);
      try {
        const answer = await git.log(path, asLogQuery(query, held), signal);
        if (signal?.aborted) return;
        setCommits(answer.commits);
        setEnded(answer.commits.length < held);
        setFault(null);
      } catch (trouble) {
        if (signal?.aborted) return;
        setFault(trouble instanceof Error ? trouble.message : String(trouble));
      } finally {
        if (!signal?.aborted) setReading(false);
      }
    },
    [path, query, shown],
  );

  // How many are being held, kept out of `read`'s dependencies: it is what the
  // next read should ask for, not a reason to read again.
  const commitsHeld = React.useRef(PAGE);
  React.useEffect(() => {
    commitsHeld.current = Math.max(PAGE, commits.length);
  }, [commits.length]);

  // A new search starts at the top, however far down the last one was read.
  React.useEffect(() => {
    commitsHeld.current = PAGE;
    setEnded(false);
  }, [query.text, query.author, query.sha, query.path, query.since, query.until, query.ref]);

  // The first read, and a fresh one whenever the search changes. Cancelled
  // together: a pane that was shut, or pointed at another project, is not owed
  // the answer to a question nobody is asking any more.
  React.useEffect(() => {
    if (!path || !shown) return;
    const stop = new AbortController();
    void read(stop.signal);
    return () => stop.abort();
  }, [read, path, shown]);

  // And again whenever the repository moves under the app -- a commit made in
  // a terminal belongs in this list without anyone pressing anything.
  const quietly = React.useCallback(() => read(undefined, true), [read]);
  useRepositoryReads(shown ? path : null, quietly);

  const more = async () => {
    if (!path || reading || ended) return;
    const wanted = commits.length + PAGE;
    setReading(true);
    try {
      const answer = await git.log(path, asLogQuery(query, wanted));
      setCommits(answer.commits);
      setEnded(answer.commits.length < wanted);
      commitsHeld.current = Math.max(PAGE, answer.commits.length);
    } catch (trouble) {
      setFault(trouble instanceof Error ? trouble.message : String(trouble));
    } finally {
      setReading(false);
    }
  };

  /**
   * Up and down walk the list; Enter opens what is under the cursor, because
   * it is an ordinary button; Escape puts the working tree back.
   *
   * The cursor is the focus ring and nothing else. Moving the selection itself
   * would open a commit — and read a patch off disk — for every press of an
   * arrow key, which is not what walking a list means.
   */
  const walked = (event: React.KeyboardEvent<HTMLUListElement>) => {
    if (event.key === 'Escape') {
      onLeave?.();
      return;
    }
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    const rows = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>('[data-testid="git-log-row"]') ?? [],
    );
    if (rows.length === 0) return;
    event.preventDefault();
    const at = rows.findIndex((row) => row === document.activeElement);
    const next = at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + step));
    rows[next]?.focus();
  };

  const searching = !isEmpty(query);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="git-history">
      <div className="shrink-0 px-3 pb-1.5 pt-2" data-testid="git-history-head">
        <CommitSearch
          line={line}
          onLine={setLine}
          found={commits.length}
          reading={reading}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2" data-testid="git-log">
        {fault && (
          <p className="py-2 font-mono text-[11px] text-danger" data-testid="git-log-error">
            {fault}
          </p>
        )}

        {commits.length === 0 && !fault ? (
          <p className="py-2 text-xs text-muted-foreground" data-testid="git-log-empty">
            {reading ? 'Reading…' : searching ? 'No commit matches.' : 'No commits yet.'}
          </p>
        ) : (
          // A plain list of buttons, not a listbox: these are things to press,
          // not a value being chosen, and the rail already holds a real
          // listbox — the branch picker — which a second set of options would
          // be indistinguishable from.
          <ul ref={list} className="flex flex-col" aria-label="Commits" onKeyDown={walked}>
            {commits.map((made, at) => {
              const open = made.sha === openSha;
              return (
                <li key={made.sha}>
                  <button
                    type="button"
                    aria-current={open || undefined}
                    tabIndex={open || (!openSha && at === 0) ? 0 : -1}
                    data-testid="git-log-row"
                    data-sha={made.sha}
                    data-open={open || undefined}
                    onClick={() => onOpen?.(made)}
                    className={cn(
                      'flex w-full flex-col gap-0.5 rounded px-1.5 py-1 text-left',
                      'hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      open && 'bg-surface-3',
                    )}
                  >
                    <div className="flex items-baseline gap-1.5">
                      <span className="shrink-0 font-mono text-[10px] text-t-tertiary">
                        {made.shortSha}
                      </span>
                      <Tooltip label={made.subject}>
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate text-xs',
                            open ? 'text-t-primary' : 'text-t-secondary',
                          )}
                        >
                          {made.subject}
                        </span>
                      </Tooltip>
                      {made.parents.length > 1 && (
                        <Tooltip label="A merge">
                          <GitMerge className="size-3 shrink-0 text-t-faint" aria-label="A merge" />
                        </Tooltip>
                      )}
                    </div>
                    <div className="flex min-w-0 items-center gap-1">
                      <span className="min-w-0 truncate text-[10px] text-t-faint">
                        {made.author} · {whenMade(made.date)}
                      </span>
                      {made.refs.slice(0, 2).map((decoration) => {
                        const { name, tag, head } = refName(decoration);
                        return (
                          <Badge
                            key={decoration}
                            size="xs"
                            variant={head ? 'primary' : tag ? 'warning' : 'secondary'}
                            appearance="light"
                            className="max-w-24 shrink-0"
                            data-testid="git-log-ref"
                          >
                            {tag && <Tag aria-hidden="true" />}
                            <span className="truncate">{name}</span>
                          </Badge>
                        );
                      })}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {commits.length > 0 && !ended && (
          <Button
            size="xs"
            variant="ghost"
            className="mt-1 w-full"
            disabled={reading}
            data-testid="git-log-more"
            onClick={() => void more()}
          >
            {reading ? 'Reading…' : 'Older commits'}
          </Button>
        )}
      </div>
    </div>
  );
}
