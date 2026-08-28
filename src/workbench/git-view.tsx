/**
 * What the project has changed, beside the conversation that changed it
 * (bw-8dp8).
 *
 * Atelier's agents write into a project's checkout all day, and until now the
 * only way to see what one of them did — or to save it — was to leave the app
 * for a terminal. This is the second of the right rail's two views, not a
 * panel of its own: the rail already sits beside this chat, already folds to
 * nothing when it is shut and already becomes a sheet on a phone, and a second
 * column beside it would leave a 390px screen with no conversation on it.
 *
 * Files are picked whole. Hunk-level staging is out of scope for this job and
 * deliberately so — it is not a smaller version of this panel but a different
 * one, with a diff view, a gutter and its own write path (the epic's notes on
 * how VS Code and GitButler do it, if it is ever wanted).
 *
 * What git says when it refuses is shown as git said it. The server hands back
 * stderr untruncated (bw-8dp8.3) and this puts it on the screen: a rejected
 * push, a commit with nothing picked and a merge conflict all explain
 * themselves perfectly well in git's own words, and rewording them into "could
 * not commit" is how a panel becomes a thing to be got around.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

import { formatDistanceToNow } from 'date-fns';
import {
  ArrowDown,
  ArrowUp,
  CloudDownload,
  Download,
  GitBranch as BranchIcon,
  Minus,
  Plus,
  RefreshCw,
  Upload,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { Textarea } from '@/components/ui/textarea';
import { git, type GitChange, type GitCommit, type GitStatus } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * How many saved changes the list asks for. Enough to recognise where the
 * branch has been this week; the rail is a column beside a conversation, not a
 * history browser.
 */
const LOG_LIMIT = 20;

/**
 * What went wrong, in git's own words.
 *
 * The server answers a failed call with git's stderr whole, and the fetch
 * wrapper puts its own `API error: 500` in front of it. The number is the app's
 * business and not the reader's, so it comes off and git's sentence leads.
 */
export function gitSaid(trouble: unknown): string {
  const said = trouble instanceof Error ? trouble.message : String(trouble);
  return said.replace(/^API error: \d+ /, '');
}

/** When a commit was made, in the words a reader thinks in. */
function whenMade(date: string): string {
  try {
    return formatDistanceToNow(new Date(date), { addSuffix: true });
  } catch {
    return date;
  }
}

/**
 * One band of the view. The same shape as the rail's own sections, kept here
 * rather than shared: importing it from the rail would have the rail and its
 * view importing each other, for four lines of class names.
 */
function Section({
  title,
  count,
  testId,
  children,
}: {
  title: string;
  count?: number;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2" data-testid={testId} data-count={count}>
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
        {count === undefined ? null : <span className="ml-1 tabular-nums text-t-faint">{count}</span>}
      </h3>
      {children}
    </div>
  );
}

/**
 * Every state a file can be in on a row: its letter, its colour, and the word
 * the letter stands for.
 *
 * The letter used to be the whole of it, and every letter was drawn in the one
 * grey the section headings were drawn in — RGB(161,161,170), measured off the
 * screen — so an added file, a changed one and a new one were the same picture
 * and telling them apart meant reading the heading above the row instead of
 * glancing at the row (bw-8dp8.10). Every other git client colours these.
 *
 * The colours are the theme's own semantic names, never a colour spelled here.
 * `success`, `warning`, `info` and `destructive` resolve through
 * `--color-*-accent` in globals.css to `--success` / `--warning` / `--info` /
 * `--danger`, which all eleven palettes set for themselves — the light ones
 * around 30-54% lightness, the dark ones 45-83%. So the hue follows whichever
 * theme is live and this file never learns which one that is, which is the
 * whole point of bw-lwp.
 *
 * Measured across all eleven palettes: the three states stay at least 56
 * degrees of hue apart in every one of them, so no theme collapses two of them
 * together. What the tokens do NOT buy is contrast on the four light palettes.
 * The letter against its own 18% tint runs 4.4-5.1:1 on the seven dark
 * palettes but only 1.8-2.8:1 on soft-light, notion-warm, github-clean and
 * catppuccin-latte. That ceiling is those palettes' own accents and not this
 * row's doing: soft-light's `--warning` cannot clear 2:1 against soft-light's
 * own page at ANY opacity, so a solid or a ghost chip does not rescue it
 * either. Every `appearance="light"` chip in the app sits under the same
 * ceiling, the `detached` badge further down this file included. Lifting it
 * means changing the light palettes in themes.css, which is a card of its own.
 *
 * Colour is therefore never the only signal, and could not be. The letter
 * stays, the section heading above it stays, and the state's word is on the
 * chip for a pointer — a reader who cannot tell green from amber loses
 * nothing.
 */
type FileState = GitChange['status'] | 'untracked' | 'conflicted';

const STATUS_LOOK: Record<
  FileState,
  { word: string; tone: 'success' | 'warning' | 'info' | 'destructive'; said: string }
> = {
  added: { word: 'A', tone: 'success', said: 'Added' },
  modified: { word: 'M', tone: 'warning', said: 'Modified' },
  // A mode or a symlink change is modification's rarer cousin, and reads as one.
  typechange: { word: 'T', tone: 'warning', said: 'Type changed' },
  renamed: { word: 'R', tone: 'info', said: 'Renamed' },
  untracked: { word: '?', tone: 'info', said: 'Untracked' },
  deleted: { word: 'D', tone: 'destructive', said: 'Deleted' },
  conflicted: { word: 'U', tone: 'destructive', said: 'Conflicted' },
};

/**
 * One changed file: what it is called, what happened to it, and the one button
 * that moves it between the two groups.
 *
 * The name is drawn first and the folder after it, dimmer, because a rail this
 * narrow truncates from the right and the name is the half that tells two files
 * apart — twelve rows all reading `src/workbench/chat-…` name nothing. The
 * folder is what gives way when there is no room, which is the way round a
 * reader wants it. The whole path is on the row for anything reading it.
 */
function FileLine({
  path,
  state,
  from,
  action,
  label,
  busy,
  onAct,
}: {
  path: string;
  state: FileState;
  from?: string | null;
  action: 'stage' | 'unstage';
  label: string;
  busy: boolean;
  onAct: () => void;
}) {
  const { word, tone, said } = STATUS_LOOK[state];
  const cut = path.lastIndexOf('/');
  const name = cut === -1 ? path : path.slice(cut + 1);
  const folder = cut === -1 ? '' : path.slice(0, cut);
  return (
    <div
      className="flex items-center gap-1.5 rounded-sm py-0.5 pl-1 hover:bg-surface-overlay"
      data-testid="git-file"
      data-path={path}
      data-status={word}
    >
      {/* The chip, not a span dressed up as one: the app has one set of parts
          and `src/components/ui/` is where a pill is allowed to be spelled out
          (src/lib/__tests__/one-set-of-parts.test.ts). `light` paints the
          letter in the state's accent on that accent at 18%, so the tint is a
          second signal beside the letter and both come from the live theme. */}
      <Badge
        size="xs"
        variant={tone}
        appearance="light"
        aria-hidden="true"
        title={said}
        className="shrink-0 font-mono"
      >
        {word}
      </Badge>
      <span
        className="flex min-w-0 flex-1 items-baseline gap-1"
        title={from ? `${from} → ${path}` : path}
      >
        <span className="min-w-0 truncate text-xs text-t-secondary">{name}</span>
        {folder && (
          // Gives way first: a folder cut short still says roughly where the
          // file lives, a name cut short says nothing at all.
          <span className="min-w-0 shrink-[10] truncate text-[10px] text-t-faint">{folder}</span>
        )}
      </span>
      <Button
        size="xs"
        mode="icon"
        variant="ghost"
        disabled={busy}
        aria-label={`${label} ${path}`}
        data-testid={`git-${action}-file`}
        onClick={onAct}
      >
        {action === 'stage' ? <Plus aria-hidden="true" /> : <Minus aria-hidden="true" />}
      </Button>
    </div>
  );
}

export interface GitViewProps {
  /** The project's working directory. Null while no project is open. */
  path: string | null;
}

export function GitView({ path }: GitViewProps) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  /**
   * Ask git where things stand. Both questions at once because they are drawn
   * together, and both cancelled together: a rail that was shut, or pointed at
   * another project, is not owed the answer to a question nobody is asking.
   */
  const read = useCallback(
    async (signal?: AbortSignal) => {
      if (!path) return;
      setReading(true);
      try {
        const [state, history] = await Promise.all([
          git.status(path, signal),
          git.log(path, LOG_LIMIT, signal),
        ]);
        if (signal?.aborted) return;
        setStatus(state);
        setCommits(history.commits);
        setFault(null);
      } catch (trouble) {
        if (signal?.aborted) return;
        setFault(gitSaid(trouble));
      } finally {
        if (!signal?.aborted) setReading(false);
      }
    },
    [path],
  );

  useEffect(() => {
    const stop = new AbortController();
    void read(stop.signal);
    return () => stop.abort();
  }, [read]);

  /**
   * One thing that changes the repository, and then a fresh look at it. The
   * answer is never guessed at from what was asked for: staging a file that is
   * also modified in the working tree leaves it in BOTH groups, and only git
   * knows that.
   */
  const act = useCallback(
    async (run: () => Promise<unknown>) => {
      if (!path) return;
      setBusy(true);
      setFault(null);
      try {
        await run();
        await read();
      } catch (trouble) {
        setFault(gitSaid(trouble));
      } finally {
        setBusy(false);
      }
    },
    [path, read],
  );

  const save = useCallback(async () => {
    if (!path) return;
    const words = message.trim();
    if (!words) return;
    setBusy(true);
    setFault(null);
    try {
      await git.commit(path, words);
      // Emptied only once it is saved: a box cleared on the way out loses what
      // the writer typed the moment git refuses the commit.
      setMessage('');
      await read();
    } catch (trouble) {
      setFault(gitSaid(trouble));
    } finally {
      setBusy(false);
    }
  }, [path, message, read]);

  if (!path) {
    return (
      <p className="px-3 py-3 text-xs text-muted-foreground" data-testid="git-no-project">
        No project directory for this chat.
      </p>
    );
  }

  const staged = status?.staged ?? [];
  const unstaged = status?.unstaged ?? [];
  const untracked = status?.untracked ?? [];
  const conflicted = status?.conflicted ?? [];
  const clean =
    status !== null &&
    staged.length === 0 &&
    unstaged.length === 0 &&
    untracked.length === 0 &&
    conflicted.length === 0;

  return (
    <div className="flex min-h-0 flex-col divide-y divide-border/60" data-testid="git-view">
      {/* The line of work, and how far it is from the shared copy. Both counts
          are drawn whether or not there is anything in them: "0 ahead, 0
          behind" is an answer, and a row that appears only when it is not zero
          is a row the reader cannot find when he goes looking for it. */}
      <div className="flex flex-col gap-1.5 px-3 py-2" data-testid="git-branch">
        <div className="flex items-center gap-1.5">
          <BranchIcon className="size-3.5 shrink-0 text-t-tertiary" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-t-primary" data-testid="git-branch-name">
            {status?.branch ?? '—'}
          </span>
          {status?.detached && (
            <Badge size="xs" variant="warning" appearance="light" data-testid="git-detached">
              detached
            </Badge>
          )}
          <Button
            size="xs"
            mode="icon"
            variant="ghost"
            disabled={busy || reading}
            aria-label="Re-read this repository"
            data-testid="git-refresh"
            onClick={() => void read()}
          >
            <RefreshCw className={cn(reading && 'animate-spin motion-reduce:animate-none')} aria-hidden="true" />
          </Button>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-0.5 tabular-nums" data-testid="git-ahead" data-count={status?.ahead ?? 0}>
            <ArrowUp className="size-3" aria-hidden="true" />
            {status?.ahead ?? 0}
            <span className="sr-only">commits ahead</span>
          </span>
          <span className="inline-flex items-center gap-0.5 tabular-nums" data-testid="git-behind" data-count={status?.behind ?? 0}>
            <ArrowDown className="size-3" aria-hidden="true" />
            {status?.behind ?? 0}
            <span className="sr-only">commits behind</span>
          </span>
          <span className="min-w-0 flex-1 truncate" data-testid="git-upstream">
            {status?.upstream ?? 'no upstream'}
          </span>
        </div>
        {/* Talking to the shared copy uses the keys and credential helper the
            user's own setup already carries — the app stores nothing.

            Drawn as outline buttons, at the size the Commit button below them
            is drawn at. They used to be bare bold words on the panel's own
            background — one of them without even an icon — sitting directly
            above a solid filled pill, so the only three things in the view
            that reach the network did not read as things you could press at
            all (bw-8dp8.10). Outline gives them an edge, a fill and the same
            height as Commit; it does not give them Commit's fill, because
            saving is the action this panel is for and it has to stay the
            loudest thing in it. Equal thirds of the row, so the three read as
            one set rather than three stray words. */}
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            disabled={busy}
            data-testid="git-fetch"
            onClick={() => void act(() => git.fetch(path))}
          >
            <CloudDownload aria-hidden="true" />
            Fetch
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            disabled={busy}
            data-testid="git-pull"
            onClick={() => void act(() => git.pull(path))}
          >
            <Download aria-hidden="true" />
            Pull
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            disabled={busy}
            data-testid="git-push"
            onClick={() => void act(() => git.push(path, status?.upstream === null))}
          >
            <Upload aria-hidden="true" />
            Push
          </Button>
        </div>
      </div>

      {fault && (
        <div className="px-3 py-2">
          {/* git's sentence, wrapped and whole, in the monospace it was written
              in — a path or a sha broken across a line is worse than useless. */}
          <Panel tone="danger" className="whitespace-pre-wrap break-words font-mono text-[11px] text-danger" data-testid="git-error">
            {fault}
          </Panel>
        </div>
      )}

      {conflicted.length > 0 && (
        <Section title="Conflicted" count={conflicted.length} testId="git-conflicted">
          <div className="flex flex-col">
            {conflicted.map((file) => (
              <FileLine
                key={file.path}
                path={file.path}
                state="conflicted"
                action="stage"
                label="Mark as resolved"
                busy={busy}
                onAct={() => void act(() => git.stage(path, [file.path]))}
              />
            ))}
          </div>
        </Section>
      )}

      {staged.length > 0 && (
        <Section title="Staged" count={staged.length} testId="git-staged">
          <div className="flex flex-col">
            {staged.map((file) => (
              <FileLine
                key={file.path}
                path={file.path}
                state={file.status}
                from={file.origPath}
                action="unstage"
                label="Unstage"
                busy={busy}
                onAct={() => void act(() => git.unstage(path, [file.path]))}
              />
            ))}
          </div>
        </Section>
      )}

      {unstaged.length > 0 && (
        <Section title="Not staged" count={unstaged.length} testId="git-unstaged">
          <div className="flex flex-col">
            {unstaged.map((file) => (
              <FileLine
                key={file.path}
                path={file.path}
                state={file.status}
                from={file.origPath}
                action="stage"
                label="Stage"
                busy={busy}
                onAct={() => void act(() => git.stage(path, [file.path]))}
              />
            ))}
          </div>
        </Section>
      )}

      {untracked.length > 0 && (
        <Section title="Untracked" count={untracked.length} testId="git-untracked">
          <div className="flex flex-col">
            {untracked.map((file) => (
              <FileLine
                key={file.path}
                path={file.path}
                state="untracked"
                action="stage"
                label="Stage"
                busy={busy}
                onAct={() => void act(() => git.stage(path, [file.path]))}
              />
            ))}
          </div>
        </Section>
      )}

      {clean && (
        <p className="px-3 py-3 text-xs text-muted-foreground" data-testid="git-clean">
          Nothing changed in this project.
        </p>
      )}

      <Section title="Commit">
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          placeholder="What changed, and why"
          aria-label="Commit message"
          data-testid="git-commit-message"
          className="min-h-16 resize-none text-xs"
        />
        <Button
          size="sm"
          variant="primary"
          // Nothing picked is not a commit git will make, and a button that
          // exists to hand back git's refusal is a button that should not have
          // been pressed. The count says why it is out.
          disabled={busy || message.trim() === '' || staged.length === 0}
          data-testid="git-commit"
          onClick={() => void save()}
        >
          {staged.length > 0 ? `Commit ${staged.length} file${staged.length === 1 ? '' : 's'}` : 'Commit'}
        </Button>
      </Section>

      <Section title="Recent commits" testId="git-log">
        {commits.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="git-log-empty">
            {reading ? 'Reading…' : 'No commits yet.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {commits.map((made) => (
              <li key={made.sha} className="flex flex-col gap-0.5" data-testid="git-log-row" data-sha={made.sha}>
                <div className="flex items-baseline gap-1.5">
                  <span className="shrink-0 font-mono text-[10px] text-t-tertiary">{made.shortSha}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-t-secondary" title={made.subject}>
                    {made.subject}
                  </span>
                </div>
                <span className="text-[10px] text-t-faint">
                  {made.author} · {whenMade(made.date)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
