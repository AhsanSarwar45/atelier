/**
 * A search box over what has been typed at this computer's shell before now.
 *
 * The terminal beside it already has the shell's own history on the up-arrow,
 * and that is the right tool for the command you ran a minute ago. This is for
 * the other one: the command from last week that you remember three words of
 * and would otherwise hold the arrow key down looking for.
 *
 * ## What it does with what you pick
 *
 * It types it at the prompt and stops there. Nothing is run. A list of old
 * commands is a list of things that were worth doing once, under conditions
 * that have since changed, and the distance between "search, glance, click" and
 * "a `git push --force` on a branch that is no longer the one you were on" is
 * one fuzzy match. So the line arrives on the prompt where it can be read and
 * corrected, and the return key stays where it has always been.
 *
 * ## Where the list comes from
 *
 * The server reads it out of the file the shell itself keeps
 * (`server/src/terminal/history.rs`), which means it is the same list as the
 * one in every other terminal on this computer, and it means a command typed
 * into a shell that is still open is not in it yet — a shell writes its history
 * on the way out. That is the same thing that is true of a second Konsole
 * window, and the alternative was typing `history` at somebody's live shell to
 * find out, which this app is not going to do.
 *
 * Fetched each time the panel opens rather than held. A history file is
 * appended to all day by every shell on the machine, and a list kept here would
 * be an hour stale by lunchtime for the sake of a read the operating system
 * has in its page cache anyway.
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { History, Search } from 'lucide-react';

import { ToolButton } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { request } from '@/lib/api';
import { cn } from '@/lib/utils';

/** One command, as the server says it. */
export type Ran = { command: string; at: number | null };

/** What `GET /api/terminal/history` answers. */
export type Told = { shell: string; readable: boolean; commands: Ran[] };

/**
 * How many rows are drawn at once.
 *
 * The list behind it is thousands long and the search is what gets you to the
 * one you want. Drawing all of them would cost a long frame every keystroke to
 * put ten thousand rows below the fold where nobody reads them; a person who
 * cannot see their command in fifty rows types another word instead, which is
 * faster for them and for the browser.
 */
const SHOWN = 50;

/**
 * Whether `command` matches everything typed in the box.
 *
 * Every word must appear, in any order and anywhere — so `git br` finds
 * `git branch -a` and also `branch: git checkout`. Order-free because the words
 * people half-remember come back in the wrong order, and substring rather than
 * fuzzy because a fuzzy match on a list of shell commands turns `rm` into a
 * match for `cargo remove`, and this list ends up on a prompt.
 */
export function matches(command: string, looking: string): boolean {
  const words = looking.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const against = command.toLowerCase();
  return words.every((word) => against.includes(word));
}

/** The matching commands, newest first, capped at what is drawn. */
export function found(commands: Ran[], looking: string): Ran[] {
  const out: Ran[] = [];
  for (const ran of commands) {
    if (!matches(ran.command, looking)) continue;
    out.push(ran);
    if (out.length === SHOWN) break;
  }
  return out;
}

/** How long ago, in the shortest form that is still true. */
export function whenAgo(at: number | null, now: number): string | null {
  if (at === null) return null;
  const seconds = Math.max(0, Math.round(now / 1000 - at));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 365) return `${days}d ago`;
  return `${Math.round(days / 365)}y ago`;
}

/** The button that opens the panel, for the tab strip to draw. */
export function HistoryButton({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  return (
    <ToolButton
      icon={<History />}
      label={open ? 'Close the command history' : 'Search the commands you have run before'}
      onClick={onOpen}
      size="xs"
      className={cn('size-5 p-0', open && 'text-t-primary')}
      data-testid="terminal-history-open"
      aria-expanded={open}
    />
  );
}

export function HistoryPanel({
  onPick,
  onClose,
}: {
  /** What to do with the command chosen: put it at the prompt, and nothing more. */
  onPick: (command: string) => void;
  onClose: () => void;
}) {
  const [told, setTold] = useState<Told | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  const [looking, setLooking] = useState('');
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement | null>(null);
  // Fixed at the moment the panel opened. A clock read during the render would
  // give every row a new answer on every keystroke, and "3m ago" does not need
  // to be right to the second it is read in.
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const answer = await request('/api/terminal/history');
        if (!answer.ok) throw new Error(`the server answered ${answer.status}`);
        const said = (await answer.json()) as Told;
        if (live) setTold(said);
      } catch (trouble) {
        if (live) setWhy(trouble instanceof Error ? trouble.message : 'the history could not be read');
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const rows = useMemo(() => found(told?.commands ?? [], looking), [told, looking]);
  // The highlight cannot point past the end of a list that just got shorter,
  // which is what happens on every keystroke that narrows it.
  const here = Math.min(at, Math.max(0, rows.length - 1));

  const pick = useCallback(
    (command: string) => {
      onPick(command);
      onClose();
    },
    [onPick, onClose],
  );

  /**
   * The keys, taken on the panel rather than on the window.
   *
   * Escape closes, and it is answered here and stopped here: the terminal
   * window deliberately leaves Escape alone because it belongs to whatever is
   * running in the shell, and a panel that let it through would be closing the
   * search and dropping somebody out of insert mode in one press.
   */
  const keyed = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setAt(Math.min(here + 1, rows.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setAt(Math.max(here - 1, 0));
      return;
    }
    if (event.key === 'Enter' && rows[here]) {
      event.preventDefault();
      pick(rows[here].command);
    }
  };

  // The highlighted row, kept in view as the arrows walk past the bottom of it.
  useEffect(() => {
    box.current?.querySelector('[data-here="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [here]);

  const empty = (): string => {
    if (why) return why;
    if (!told) return 'Reading what you have run before…';
    if (!told.readable) {
      return `${told.shell} keeps its history in a form this app cannot read, so there is nothing to search.`;
    }
    if (!told.commands.length) return 'Your shell has not written down any commands yet.';
    return 'Nothing you have run matches that.';
  };

  return (
    <div
      data-testid="terminal-history-panel"
      role="dialog"
      aria-label="Command history"
      className="absolute inset-0 z-10 flex flex-col bg-surface-overlay"
      onKeyDown={keyed}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-2 py-1.5">
        <Search className="size-3.5 shrink-0 text-t-tertiary" aria-hidden />
        <Input
          autoFocus
          value={looking}
          onChange={(event) => {
            setLooking(event.target.value);
            setAt(0);
          }}
          placeholder="Search the commands you have run"
          aria-label="Search the commands you have run"
          data-testid="terminal-history-search"
          className="h-6 border-0 bg-transparent px-0 text-xs focus-visible:ring-0"
        />
      </div>
      <div ref={box} className="min-h-0 flex-1 overflow-y-auto py-1">
        {rows.length === 0 ? (
          <p data-testid="terminal-history-empty" className="px-3 py-2 text-xs text-t-tertiary">
            {empty()}
          </p>
        ) : (
          rows.map((ran, index) => {
            const ago = whenAgo(ran.at, now);
            return (
              <Button
                // The command, because the list is already de-duplicated on it
                // by the server and two rows can never carry the same one.
                key={ran.command}
                variant="ghost"
                size="xs"
                data-testid="terminal-history-row"
                data-here={index === here ? 'true' : undefined}
                onMouseEnter={() => setAt(index)}
                onClick={() => pick(ran.command)}
                className={cn(
                  'h-auto w-full justify-start gap-3 rounded-none px-3 py-1 text-left font-mono text-xs font-normal text-t-secondary',
                  index === here && 'bg-surface-raised text-t-primary',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{ran.command}</span>
                {ago && <span className="shrink-0 font-sans text-[10px] text-t-tertiary">{ago}</span>}
              </Button>
            );
          })
        )}
      </div>
      <p className="shrink-0 border-t border-border/40 px-3 py-1 text-[10px] text-t-tertiary">
        The one you pick goes to the prompt to run or change — nothing is run for you.
      </p>
    </div>
  );
}
