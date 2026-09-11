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

import { useCallback, useEffect, useRef, useState } from 'react';

import { formatDistanceToNow } from 'date-fns';
import {
  ArrowDown,
  ArrowUp,
  CloudDownload,
  Download,
  FileDiff,
  GitBranch as BranchIcon,
  Minus,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
  Upload,
} from 'lucide-react';

import { ToolButton } from '@/components/shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Panel } from '@/components/ui/panel';
import { Picker } from '@/components/ui/picker';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip } from '@/components/ui/tooltip';
import { ApiError, git, type GitBranch, type GitChange, type GitCommit, type GitStatus } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  howManyFiles,
  quietlyOn,
  reportOn,
  type DeedReport,
  type GitDeed,
} from '@/workbench/git-deeds';
import { usePathActions } from '@/workbench/path-menu';
import { useRepositoryReads } from '@/workbench/use-repository-reads';

/**
 * A repository-relative path made absolute. git talks in paths relative to the
 * checkout; everything that OPENS a path in this app talks in absolute ones.
 */
export function under(root: string, file: string): string {
  return `${root.replace(/\/+$/, '')}/${file}`;
}

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

/**
 * Whether the call failed for want of a key nobody has unlocked.
 *
 * The server marks the one refusal an SSH passphrase could clear, and says so
 * in the answer rather than in the sentence — ssh gives the same words whether
 * a key is locked, missing or simply not accepted, so no amount of reading its
 * text would tell them apart. Anything else is left alone: a rejected push and
 * an HTTPS password are not a locked key, and offering to unlock one would
 * send the reader hunting for a passphrase that was never the trouble.
 */
function wantsAKey(trouble: unknown): boolean {
  return (
    trouble instanceof ApiError
    && (trouble.body as { needsPassphrase?: boolean } | undefined)?.needsPassphrase === true
  );
}

/**
 * What a call is to be reported as: which operation it is, the short line that
 * goes under the label, and — where git's own answer says it better than the
 * panel could guess — how to read that line off what came back.
 *
 * `quiet` is for an operation whose result is already on the screen; see
 * `quietlyOn`. It still reports a failure.
 */
interface Telling {
  deed: GitDeed;
  note?: string;
  quiet?: boolean;
  ended?: (answer: unknown) => string | undefined;
}

/** A commit subject cut to the length a toast has room for. */
function shortened(subject: string): string {
  const one = subject.split('\n')[0].trim();
  return one.length > 60 ? `${one.slice(0, 59)}…` : one;
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
  actions,
  children,
}: {
  title: string;
  count?: number;
  testId?: string;
  /** What can be done to the whole group, drawn on the heading's own line. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2" data-testid={testId} data-count={count}>
      {/* The heading and the group's own buttons share one line: a rail this
          narrow has no room for a second, and a bulk action belongs against
          the group it acts on rather than in a menu somewhere above it. */}
      <div className="flex items-center gap-1">
        <h3 className="min-w-0 flex-1 truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
          {count === undefined ? null : <span className="ml-1 tabular-nums text-t-faint">{count}</span>}
        </h3>
        {actions}
      </div>
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
export type FileState = GitChange['status'] | 'untracked' | 'conflicted';

export const STATUS_LOOK: Record<
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
  absolute,
  state,
  from,
  action,
  label,
  busy,
  onAct,
  extra,
}: {
  path: string;
  /** Where the file is on disk, so the row opens like every other path. */
  absolute: string;
  state: FileState;
  from?: string | null;
  action: 'stage' | 'unstage';
  label: string;
  busy: boolean;
  onAct: () => void;
  /**
   * The row's other button, when it has one — Discard beside Stage, or Remove
   * beside it on a file git has never heard of. Built where the row is used,
   * because what it does is the view's business and not the row's.
   */
  extra?: React.ReactNode;
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
      <Tooltip label={said}>
        <Badge
          size="xs"
          variant={tone}
          appearance="light"
          aria-hidden="true"
          className="shrink-0 font-mono"
        >
          {word}
        </Badge>
      </Tooltip>
      {/* The name carries the marks every other file name in this app carries,
          and no handler of its own: the rail's own listeners answer them — the
          Files tab on a click, the editor on Alt-click, the menu on a
          right-click (bw-g3o3.9). It keeps the row's own type and weight rather
          than becoming a capsule, because a rail of twelve capsules is a rail
          nobody can read down. */}
      <Tooltip label={from ? `${from} → ${path}` : `${path} — click to open in the Files tab`}>
        <span
          className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-1 hover:text-foreground"
          data-path-mention={absolute}
          data-path-look="link"
        >
          <span className="min-w-0 truncate text-xs text-t-secondary">{name}</span>
          {folder && (
            // Gives way first: a folder cut short still says roughly where the
            // file lives, a name cut short says nothing at all.
            <span className="min-w-0 shrink-[10] truncate text-[10px] text-t-faint">{folder}</span>
          )}
        </span>
      </Tooltip>
      {extra}
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
  /**
   * Whether the chat around this panel is showing the diff instead of the
   * transcript (bw-rx1y.4). The panel does not draw the diff — that stands in
   * the conversation's own place, which is wider than this column will ever be
   * — but the button that asks for it belongs here, on the line that already
   * says which checkout is being read. Without `onFlipDiff` there is no button,
   * so a rail drawn outside a chat is unchanged.
   */
  diffOpen?: boolean;
  onFlipDiff?: () => void;
}

export function GitView({ path, diffOpen = false, onFlipDiff }: GitViewProps) {
  // The rail's file names are file chips, answered by the one set of handlers
  // every other file chip in the app is answered by (bw-g3o3.9).
  const paths = usePathActions();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  /** The lines of work this checkout could move to. */
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  /**
   * Whether Commit rewrites the last saved change rather than adding one.
   * Sticky only until it is used: `save` turns it off again, so an amend is
   * never the thing that quietly happens to the next commit as well.
   */
  const [amend, setAmend] = useState(false);
  /**
   * The destructive thing that has been asked for and not yet agreed to.
   *
   * There is no `window.confirm` anywhere in here. The browser's box is drawn
   * outside the app, cannot be styled, cannot be reached by the end-to-end
   * run without special handling, and — the reason that matters — blocks the
   * whole page while it is up. This is the app's own modal dialog, the same
   * one the passphrase is asked for in, and it names the thing it is about to
   * throw away.
   *
   * `run` is held as a function returning a function, because a plain one
   * handed to `setAsking` would be taken for an updater and called on the spot
   * — the very call the reader has not agreed to yet.
   */
  const [asking, setAsking] = useState<{
    said: string;
    verb: string;
    told: Telling;
    run: () => Promise<unknown>;
  } | null>(null);
  /**
   * The call that came back wanting an unlocked key, kept so that answering
   * the prompt runs the very thing the reader asked for rather than a guess at
   * it — a push that was setting an upstream is still setting one on the
   * second go. How it is to be reported travels with it, so the retry raises
   * the same toast the first go would have.
   */
  const [locked, setLocked] = useState<
    { told: Telling; run: (passphrase?: string) => Promise<unknown> } | null
  >(null);
  /**
   * What the reader has typed. Held no longer than the call it is for: every
   * path out of `act` empties it, so it is gone whether the key opened or not.
   */
  const [passphrase, setPassphrase] = useState('');
  /**
   * Whether a passphrase was already tried and did not open the key. Kept
   * apart from `fault` because it is not a failure of the action — the reader
   * is still in the middle of doing it — so it is said quietly inside the
   * prompt rather than as the panel's red word on the call (bw-8nwh.1).
   */
  const [keyRefused, setKeyRefused] = useState(false);
  /**
   * Which of the two things that can fail put the words in the red panel.
   *
   * The panel re-reads itself every few seconds, and a read that works used to
   * clear the panel — including the words a push had just failed with, five
   * seconds after the reader pressed the button (bw-8qrr.1). A push also moves
   * the git directory, so the watcher fired a read at once and the failure was
   * regularly gone before it could be read at all: pressing Push and being
   * told nothing was the everyday result.
   *
   * So a read clears only what a read put there. What an operation failed with
   * stays until the reader does something else, which is the next time it
   * could possibly be out of date.
   */
  const faultFrom = useRef<'a read' | 'an operation' | null>(null);

  /**
   * Ask git where things stand. Both questions at once because they are drawn
   * together, and both cancelled together: a rail that was shut, or pointed at
   * another project, is not owed the answer to a question nobody is asking.
   */
  const read = useCallback(
    async (signal?: AbortSignal, quietly?: boolean) => {
      if (!path) return;
      // A read nobody asked for does not spin the refresh button or grey it
      // out. The panel now reads on its own — when the repository moves, when
      // the window comes back, and slowly while it is on screen — and a
      // spinner flickering every few seconds beside numbers that did not
      // change reads as the panel doing something, not as it being current.
      if (!quietly) setReading(true);
      try {
        const [state, history] = await Promise.all([
          git.status(path, signal),
          git.log(path, LOG_LIMIT, signal),
        ]);
        if (signal?.aborted) return;
        setStatus(state);
        setCommits(history.commits);
        if (faultFrom.current !== 'an operation') {
          setFault(null);
          faultFrom.current = null;
        }
      } catch (trouble) {
        if (signal?.aborted) return;
        setFault(gitSaid(trouble));
        faultFrom.current = 'a read';
      } finally {
        if (!quietly && !signal?.aborted) setReading(false);
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
   * What this checkout could move to, read again whenever it moves — a branch
   * made in a terminal a minute ago has to be in the list, and the one just
   * switched to has to be the one showing (bw-ov7a.8).
   *
   * It is asked for on its own rather than beside the status: the panel is
   * drawn from what git says about the working tree, and a repository whose
   * branch list cannot be read is still a repository whose changes are worth
   * showing.
   */
  useEffect(() => {
    if (!path) {
      setBranches([]);
      return;
    }
    const stop = new AbortController();
    void (async () => {
      try {
        const lines = await git.branches(path, stop.signal);
        if (!stop.signal.aborted) setBranches(lines.branches);
      } catch {
        if (!stop.signal.aborted) setBranches([]);
      }
    })();
    return () => stop.abort();
  }, [path, status?.branch]);

  /**
   * Staying current: the git directory moving, the window being come back to,
   * and the slow look for a working-tree edit no watcher can see. The rule for
   * all three — and the one-read-at-a-time that keeps a burst of events from
   * racing itself — is `useRepositoryReads`, which the diff that stands in for
   * the transcript shares with this panel (bw-rx1y.5).
   *
   * Quietly: a read nobody asked for does not spin the refresh button.
   */
  const quietly = useCallback(async () => {
    await read(undefined, true);
  }, [read]);
  useRepositoryReads(path, quietly);

  /**
   * One thing that changes the repository, and then a fresh look at it. The
   * answer is never guessed at from what was asked for: staging a file that is
   * also modified in the working tree leaves it in BOTH groups, and only git
   * knows that.
   */
  const act = useCallback(
    async (
      told: Telling,
      run: (passphrase?: string) => Promise<unknown>,
      unlockWith?: string,
    ) => {
      if (!path) return;
      setBusy(true);
      setFault(null);
      faultFrom.current = null;
      // Raised before the call and not after it, because the toast IS the
      // wait: a push over a slow link is a minute of a reader wondering
      // whether anything at all is happening, and "Pushing" is the answer to
      // that. The same toast then becomes the outcome, so the story is told
      // once rather than twice (bw-8qrr.2).
      const telling: DeedReport = told.quiet
        ? quietlyOn(told.deed, told.note)
        : reportOn(told.deed, told.note);
      try {
        const answer = await run(unlockWith);
        setLocked(null);
        setKeyRefused(false);
        telling.worked(told.ended?.(answer) ?? told.note);
        await read();
      } catch (trouble) {
        if (wantsAKey(trouble)) {
          // Nothing has gone wrong yet: the call is waiting on a key, and the
          // way on is the prompt. So no fault is set — see the form below —
          // and the toast is let go rather than left spinning behind a dialog
          // that is now the thing the reader is being asked about.
          telling.letGo();
          setLocked({ told, run });
          // Only the second and later goes are a refusal of what was typed;
          // the first is the call finding the key locked in the first place.
          setKeyRefused(unlockWith !== undefined);
        } else {
          const said = gitSaid(trouble);
          telling.failed(said);
          setFault(said);
          faultFrom.current = 'an operation';
          setLocked(null);
          setKeyRefused(false);
        }
      } finally {
        // Never held past the call it was typed for, on either outcome.
        setPassphrase('');
        setBusy(false);
      }
    },
    [path, read],
  );

  /**
   * Saying no to the key, whichever way it is said.
   *
   * Cancel, Escape and a press on the dim behind the dialog are one word, so
   * they are one function: the call is let go of, what was typed is dropped,
   * and the refusal sentence goes with it. Nothing is reported, because
   * nothing went wrong — the reader simply decided not to.
   */
  const waveOffTheKey = useCallback(() => {
    setLocked(null);
    setPassphrase('');
    setKeyRefused(false);
  }, []);

  const save = useCallback(async () => {
    if (!path) return;
    const words = message.trim();
    if (!words) return;
    setBusy(true);
    setFault(null);
    faultFrom.current = null;
    const telling = reportOn(amend ? 'amend' : 'commit', shortened(words));
    try {
      // Said only when it is meant: an ordinary commit is the very call it
      // always was, amend and all left off the wire.
      if (amend) await git.commit(path, words, true);
      else await git.commit(path, words);
      // Emptied only once it is saved: a box cleared on the way out loses what
      // the writer typed the moment git refuses the commit. The amend goes off
      // with it, so the next commit is an ordinary one unless it is asked for
      // again.
      setMessage('');
      setAmend(false);
      telling.worked();
      await read();
    } catch (trouble) {
      const said = gitSaid(trouble);
      telling.failed(said);
      setFault(said);
      faultFrom.current = 'an operation';
    } finally {
      setBusy(false);
    }
  }, [path, message, amend, read]);

  /**
   * Ask before throwing work away, and only then do it.
   *
   * Everything destructive in this panel goes through here, so there is one
   * place that decides what asking looks like and one shape of answer.
   */
  const askFirst = useCallback(
    (said: string, verb: string, told: Telling, run: () => Promise<unknown>) => {
      setAsking({ said, verb, told, run });
    },
    [],
  );

  /**
   * Turning the amend on with nothing typed borrows the last commit's subject,
   * so the common case — rewriting what was just saved, keeping its wording —
   * is a tick and a press rather than retyping a line that is on the screen
   * already. Anything the writer has typed is left exactly as it is.
   */
  const wantAmend = useCallback(
    (wanted: boolean) => {
      setAmend(wanted);
      if (wanted && message.trim() === '' && commits[0]) setMessage(commits[0].subject);
    },
    [message, commits],
  );

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
    <div className="flex min-h-0 flex-col divide-y divide-border/60" data-testid="git-view" {...paths.chips}>
      {paths.menu}
      {/* The line of work, and how far it is from the shared copy. Both counts
          are drawn whether or not there is anything in them: "0 ahead, 0
          behind" is an answer, and a row that appears only when it is not zero
          is a row the reader cannot find when he goes looking for it. */}
      <div className="flex flex-col gap-1.5 px-3 py-2" data-testid="git-branch">
        {/* Tight against the icon on purpose: the picker beside it carries its
            own room inside, so the eye reads one gap between the two and not
            two gaps added together (bw-r9vq.1). */}
        <div className="flex items-center gap-1">
          <BranchIcon className="size-3.5 shrink-0 text-t-tertiary" aria-hidden="true" />
          {/* The branch is where you change it, not just where it is written:
              a person who works in branches had to leave the app for a
              terminal to move between them (bw-ov7a.8). It keeps the name's
              own place and weight on the line — no border, no fill — so the
              row reads as it always did until it is pressed. The room inside
              it is its own — pulling it back out with a negative margin put the
              ring over the icon (bw-r9vq.1) — so the name sits a little further
              along the line than it used to and the ring has daylight on both
              sides. */}
          <Picker
            label="Branch"
            data-testid="git-branch-name"
            className="h-6 min-w-0 flex-1 rounded border-0 px-2 text-xs font-medium text-t-primary shadow-none"
            placeholder={status?.branch ?? '—'}
            searchPlaceholder="Search branches"
            empty="No branch matches"
            value={status?.branch ?? ''}
            disabled={busy || reading || !path || branches.length === 0}
            choices={branches
              .filter((branch) => !branch.isRemote)
              .map((branch) => ({ value: branch.name, label: branch.name }))}
            onChange={(branch) => {
              if (!path || branch === status?.branch) return;
              void act({ deed: 'checkout', note: branch }, () => git.checkout(path, branch));
            }}
          />
          {status?.detached && (
            <Badge size="xs" variant="warning" appearance="light" data-testid="git-detached">
              detached
            </Badge>
          )}
          {onFlipDiff && (
            <ToolButton
              icon={<FileDiff />}
              label={diffOpen ? 'Hide diff' : 'Show diff'}
              emphasis={diffOpen ? 'loud' : 'quiet'}
              data-testid="git-diff-toggle"
              aria-pressed={diffOpen}
              onClick={onFlipDiff}
            />
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
          {/* One ref ordinarily, two when the repository pushes somewhere other
              than it follows — `remote.origin.push` can send this branch to a
              name its upstream never hears about, and then a single name here
              is a name one of the two counts was not taken against
              (bw-xp12.2). The arrow is the push, in the direction the button
              below sends. */}
          <span className="min-w-0 flex-1 truncate" data-testid="git-upstream">
            {status?.upstream ?? 'no upstream'}
            {status?.pushTo && (
              <span data-testid="git-push-to"> → {status.pushTo}</span>
            )}
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
            onClick={() =>
              void act(
                {
                  deed: 'fetch',
                  note: status?.upstream ?? 'origin',
                  // git says nothing worth reading on a fetch; where the
                  // branch stands afterwards is the whole of what was wanted,
                  // and the server counts it for us.
                  ended: (answer) => {
                    const stood = answer as { ahead?: number; behind?: number } | undefined;
                    return `${stood?.ahead ?? 0} ahead · ${stood?.behind ?? 0} behind`;
                  },
                },
                (key) => git.fetch(path, key),
              )
            }
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
            onClick={() =>
              void act(
                { deed: 'pull', note: `${status?.upstream ?? 'origin'} → ${status?.branch ?? 'HEAD'}` },
                (key) => git.pull(path, key),
              )
            }
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
            onClick={() =>
              void act(
                // Where git will really write, which is not always what the
                // branch follows (bw-xp12.2).
                {
                  deed: 'push',
                  note: `${status?.branch ?? 'HEAD'} → ${status?.pushTo ?? status?.upstream ?? 'origin'}`,
                },
                (key) => git.push(path, status?.upstream === null, key),
              )
            }
          >
            <Upload aria-hidden="true" />
            Push
          </Button>
        </div>
      </div>

      {/* The way out of a refusal a key could clear (bw-k778), asked for in
          the app's own modal dialog rather than as a strip wedged into the
          panel (bw-ahf2.1). A rail 320px wide had the box for a passphrase
          sitting between the Push button and the list of changes, where it
          could be scrolled out of sight while the call it belongs to waits;
          asking for something is not a row in a list, and the app already has
          one way of asking, which every other question in it uses.

          It is still drawn in place of git's words, not above them (bw-8nwh.1):
          a locked key is not
          a failure the reader has to read about, it is a question, and the
          panel used to answer a press of Push with a red block of ssh's stderr
          — the same three lines whether the key is locked, missing or refused
          — sitting over a box asking for a passphrase. Nothing has gone wrong
          that the next keystroke does not fix, so nothing is put in red. The
          red panel is kept for what it is for: a passphrase that opened
          nothing says so quietly below, in the prompt it belongs to, and only
          a failure no key would clear drops the prompt and shows git's words.
          Cancelling leaves the view as it was, with no error behind it.

          Nothing here is remembered. The field empties on every outcome, the
          app never writes the passphrase down, and the server keeps it only
          for the one call it is sent with. */}
      <Dialog
        open={locked !== null}
        onOpenChange={(wanted) => {
          // Escape, the cross and a press on the dim behind all mean Cancel,
          // and go through the one function that means it.
          if (!wanted) waveOffTheKey();
        }}
      >
        <DialogContent
          className="w-[90vw] gap-3 border-b-default bg-surface-raised sm:max-w-md"
          data-testid="git-passphrase"
        >
          {/* Not the same words as the field's own label, deliberately: the
              dialog is named by its title, so a title reading "SSH key
              passphrase" would give the box and the field inside it the same
              accessible name and leave "the passphrase field" ambiguous to a
              screen reader and to anything looking for it by that name. */}
          <DialogHeader>
            <DialogTitle className="text-base text-t-primary">Unlock your SSH key</DialogTitle>
            <DialogDescription>Used for this one call and not kept.</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(sending) => {
              sending.preventDefault();
              if (!locked) return;
              // Put away before the call, not after it (bw-8qrr.2). The push
              // the passphrase unlocks is the long part of the evening — a
              // large one runs for minutes — and the dialog used to sit there
              // for all of it with its field greyed out and nothing moving,
              // which reads as an app that has hung rather than one that is
              // working. The wait belongs in the toast `act` raises, where it
              // can be watched from anywhere on the page; a refused key brings
              // the prompt straight back with the reason in it.
              const { told, run } = locked;
              const typed = passphrase;
              setLocked(null);
              setPassphrase('');
              void act(told, run, typed);
            }}
          >
            <div className="flex flex-col gap-1.5">
              <label htmlFor="git-passphrase-field" className="text-xs font-medium text-t-secondary">
                SSH key passphrase
              </label>
              <Input
                id="git-passphrase-field"
                data-testid="git-passphrase-field"
                type="password"
                autoFocus
                autoComplete="off"
                placeholder="Passphrase for your key"
                value={passphrase}
                disabled={busy}
                onChange={(typing) => setPassphrase(typing.target.value)}
              />
              {keyRefused && (
                <p className="text-[11px] text-danger" data-testid="git-passphrase-refused">
                  That passphrase did not unlock the key. Try again.
                </p>
              )}
            </div>
            <DialogFooter className="gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                data-testid="git-unlock-cancel"
                onClick={waveOffTheKey}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={busy || passphrase.length === 0}
                data-testid="git-unlock"
              >
                Unlock and retry
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* The one thing that stands between a press and work that cannot be got
          back, and now the app's own modal dialog rather than a red strip in
          the panel (bw-ahf2.1). A strip could be scrolled past, and sat in the
          same column as the rows it was about — a question about throwing work
          away should stop the reader, which is what a modal is for. It says
          what would go, in the words of the thing itself, and the button that
          agrees is the only red one in it. Keep is the way out and does nothing
          at all; so are Escape, the cross and a press on the dim behind. */}
      <Dialog
        open={asking !== null}
        onOpenChange={(wanted) => {
          if (!wanted) setAsking(null);
        }}
      >
        {asking && (
          // A decision that has to be answered rather than a form to fill in,
          // so it is announced as one. The app's dialog is the part it is
          // built from either way — `alert-dialog.tsx` is reached by nothing
          // in the app and asks for `--dialog-overlay`, `--dialog-z` and
          // `--mix-card-5-bg`, none of which any theme defines, so it would
          // draw its dim in an invalid colour at no stacking order at all.
          <DialogContent
            role="alertdialog"
            className="w-[90vw] gap-3 border-b-default bg-surface-raised sm:max-w-md"
            data-testid="git-confirm-dialog"
          >
            <DialogHeader>
              <DialogTitle className="text-base text-t-primary">{asking.verb}</DialogTitle>
              <DialogDescription className="break-words">{asking.said}</DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                data-testid="git-confirm-cancel"
                onClick={() => setAsking(null)}
              >
                Keep
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                data-testid="git-confirm"
                onClick={() => {
                  const { run, told } = asking;
                  setAsking(null);
                  void act(told, () => run());
                }}
              >
                {asking.verb}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

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
                absolute={under(path, file.path)}
                state="conflicted"
                action="stage"
                label="Mark as resolved"
                busy={busy}
                onAct={() =>
                  void act({ deed: 'stage', quiet: true, note: file.path }, () =>
                    git.stage(path, [file.path]),
                  )
                }
              />
            ))}
          </div>
        </Section>
      )}

      {staged.length > 0 && (
        <Section
          title="Staged"
          count={staged.length}
          testId="git-staged"
          actions={
            <Button
              size="xs"
              variant="ghost"
              className="h-5 px-1 text-[10px]"
              disabled={busy}
              data-testid="git-unstage-all"
              onClick={() =>
                void act(
                  { deed: 'unstage', quiet: true, note: howManyFiles(staged.length) },
                  () => git.unstageAll(path),
                )
              }
            >
              <Minus aria-hidden="true" />
              Unstage all
            </Button>
          }
        >
          <div className="flex flex-col">
            {staged.map((file) => (
              <FileLine
                key={file.path}
                path={file.path}
                absolute={under(path, file.path)}
                state={file.status}
                from={file.origPath}
                action="unstage"
                label="Unstage"
                busy={busy}
                onAct={() =>
                  void act({ deed: 'unstage', quiet: true, note: file.path }, () =>
                    git.unstage(path, [file.path]),
                  )
                }
              />
            ))}
          </div>
        </Section>
      )}

      {unstaged.length > 0 && (
        <Section
          title="Not staged"
          count={unstaged.length}
          testId="git-unstaged"
          actions={
            <>
              <Button
                size="xs"
                variant="ghost"
                className="h-5 px-1 text-[10px]"
                disabled={busy}
                data-testid="git-stage-all"
                onClick={() =>
                void act({ deed: 'stage', quiet: true }, () => git.stageAll(path))
              }
              >
                <Plus aria-hidden="true" />
                Stage all
              </Button>
              {/* Everything back to the last saved change, and every new file
                  gone with it. What the project ignores is kept — this is not
                  the button that eats somebody's .env. */}
              <Button
                size="xs"
                variant="ghost"
                className="h-5 px-1 text-[10px] text-danger"
                disabled={busy}
                data-testid="git-discard-all"
                onClick={() =>
                  askFirst(
                    'Discard every change in this project? Files that are new will be deleted; ignored files are kept. This cannot be undone.',
                    'Discard all',
                    { deed: 'discard', note: howManyFiles(unstaged.length + untracked.length) },
                    () => git.discardAll(path),
                  )
                }
              >
                <Trash2 aria-hidden="true" />
                Discard all
              </Button>
            </>
          }
        >
          <div className="flex flex-col">
            {unstaged.map((file) => (
              <FileLine
                key={file.path}
                path={file.path}
                absolute={under(path, file.path)}
                state={file.status}
                from={file.origPath}
                action="stage"
                label="Stage"
                busy={busy}
                onAct={() =>
                  void act({ deed: 'stage', quiet: true, note: file.path }, () =>
                    git.stage(path, [file.path]),
                  )
                }
                extra={
                  <Tooltip label={`Discard changes to ${file.path}`}>
                    <Button
                      size="xs"
                      mode="icon"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`Discard changes to ${file.path}`}
                      data-testid="git-discard"
                      onClick={() =>
                        askFirst(
                          `Discard changes to ${file.path}? This cannot be undone.`,
                          'Discard',
                          { deed: 'discard', note: file.path },
                          () => git.discard(path, [file.path]),
                        )
                      }
                    >
                      <Undo2 aria-hidden="true" />
                    </Button>
                  </Tooltip>
                }
              />
            ))}
          </div>
        </Section>
      )}

      {untracked.length > 0 && (
        <Section
          title="Untracked"
          count={untracked.length}
          testId="git-untracked"
          actions={
            <Button
              size="xs"
              variant="ghost"
              className="h-5 px-1 text-[10px]"
              disabled={busy}
              data-testid="git-stage-all"
              onClick={() =>
                void act({ deed: 'stage', quiet: true }, () => git.stageAll(path))
              }
            >
              <Plus aria-hidden="true" />
              Stage all
            </Button>
          }
        >
          <div className="flex flex-col">
            {untracked.map((file) => (
              <FileLine
                key={file.path}
                path={file.path}
                absolute={under(path, file.path)}
                state="untracked"
                action="stage"
                label="Stage"
                busy={busy}
                onAct={() =>
                  void act({ deed: 'stage', quiet: true, note: file.path }, () =>
                    git.stage(path, [file.path]),
                  )
                }
                extra={
                  <Tooltip label={`Delete ${file.path}`}>
                    <Button
                      size="xs"
                      mode="icon"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`Delete ${file.path}`}
                      data-testid="git-remove"
                      onClick={() =>
                        askFirst(
                          `Delete ${file.path}? git has no copy of it, so this cannot be undone.`,
                          'Delete',
                          { deed: 'remove', note: file.path },
                          () => git.remove(path, [file.path]),
                        )
                      }
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </Tooltip>
                }
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
        {/* Rewriting the last saved change rather than adding one. A tick
            and not a second button, because it changes what Commit does
            instead of being a different thing to press — and it says so, on
            the button, before it is pressed. */}
        {/* The row, not the tick, is what a thumb lands on. A sixteen-pixel
            box can only grow an invisible target as far as the padding of the
            rail it sits in, and this rail's is twelve — two short of the floor
            (bw-e3dw.6). Its own words are right beside it and toggle it, so the
            line they share is the target, and it is the floor tall. */}
        <label className="flex min-h-11 items-center gap-1.5 text-[11px] text-muted-foreground">
          <Checkbox
            checked={amend}
            disabled={busy}
            data-testid="git-amend"
            onCheckedChange={(wanted) => wantAmend(wanted === true)}
          />
          Amend last commit
        </label>
        <Button
          size="sm"
          variant="primary"
          // Nothing picked is not a commit git will make, and a button that
          // exists to hand back git's refusal is a button that should not have
          // been pressed. The count says why it is out. An amend is the one
          // exception: rewording the last saved change picks nothing up, and
          // git makes that commit perfectly happily.
          disabled={busy || message.trim() === '' || (!amend && staged.length === 0)}
          data-testid="git-commit"
          onClick={() => void save()}
        >
          {amend
            ? 'Amend last commit'
            : staged.length > 0
              ? `Commit ${staged.length} file${staged.length === 1 ? '' : 's'}`
              : 'Commit'}
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
                  <Tooltip label={made.subject}>
                    <span className="min-w-0 flex-1 truncate text-xs text-t-secondary">
                      {made.subject}
                    </span>
                  </Tooltip>
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
