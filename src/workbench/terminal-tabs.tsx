/**
 * The one terminal window, with a tab for each shell in it.
 *
 * This is the view of `terminal-shells.tsx`: that file decides what shells
 * there are and what happens to them, and this one draws them inside the
 * floating chrome from `terminal-window.tsx`. `Terminals` is what the app
 * mounts, once, around everything (`src/app/layout.tsx`).
 *
 * ## A hidden tab is hidden, never unmounted
 *
 * Every tab's pane stays mounted for as long as its tab exists, and switching
 * tabs only changes which one is displayed. `TerminalPane` builds its terminal
 * and its socket in an effect and destroys both in that effect's cleanup, on
 * purpose and for good reasons of its own — so unmounting a pane to hide it
 * would drop the socket, throw away everything the shell had printed and put
 * the reader back at the bottom of a screen they had scrolled up from. Hiding
 * costs a box with no size, which is a state the pane is built to sit in
 * quietly: it measures nothing until it has a size again.
 *
 * The same reasoning is why a closed window is hidden rather than taken down.
 * Once a shell has been opened the window stays in the page, showing or not,
 * and the sockets stay attached with it; it goes only when the last tab is
 * closed and there is nothing left to keep.
 */
'use client';

import { type ReactNode } from 'react';

import { Plus, X } from 'lucide-react';

import { ToolButton } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { TerminalPane } from './terminal-pane';
import { TerminalShells, useTerminalShells } from './terminal-shells';
import { TerminalWindow } from './terminal-window';

/**
 * What a tab is called: the last part of the folder its shell started in.
 *
 * The whole path is too long for a tab and the interesting end of it is the
 * last segment, which is the project. A shell that named no folder is the one
 * the server started at home, and `~` is what home is called on the only kind
 * of screen this app draws.
 */
export function tabName(folder: string | null): string {
  if (!folder) return '~';
  return folder.split(/[\\/]/).filter(Boolean).pop() ?? '/';
}

/** The whole path, for the tooltip and for whoever is listening rather than looking. */
function tabWhere(folder: string | null): string {
  return folder ?? 'your home folder';
}

/** The row of tabs, under the window's own bar. */
function TabStrip() {
  const { tabs, active, select, closeTab, openTab, opening } = useTerminalShells();
  return (
    <div
      role="tablist"
      aria-label="Shells"
      data-testid="terminal-tab-strip"
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/40 bg-surface-overlay px-2 py-1"
    >
      {tabs.map((tab) => {
        const showing = tab.id === active;
        return (
          <div
            key={tab.id}
            data-testid="terminal-tab"
            className={cn(
              'flex shrink-0 items-center rounded-sm pr-0.5',
              showing ? 'bg-surface-base' : 'hover:bg-surface-base/60',
            )}
          >
            {/* The name and the cross are two controls side by side rather than
                one inside the other: a button inside a button is neither valid
                nor operable, and closing a tab is not a way of selecting it.
                The library's `Button` and not a bare one with paint on it: a tab
                is a control, and the house keeps every control's paint in one
                place (`scripts/one-library.py`). What is left here is which of
                the two it is, which is the only thing a tab knows that a button
                does not. */}
            <Button
              variant="ghost"
              size="xs"
              role="tab"
              aria-selected={showing}
              title={tabWhere(tab.folder)}
              onClick={() => select(tab.id)}
              className={cn(
                'h-6 max-w-40 truncate px-2 font-normal',
                showing ? 'text-t-primary' : 'text-t-tertiary hover:text-t-primary',
              )}
            >
              {tabName(tab.folder)}
            </Button>
            <ToolButton
              icon={<X />}
              // Named by the folder rather than by the short name on the tab:
              // two shells in two projects called `web` are one tab apart, and
              // this is the label somebody closing one by ear hears.
              label={`Close the shell in ${tabWhere(tab.folder)}`}
              onClick={() => closeTab(tab.id)}
              size="xs"
              className="size-5 p-0"
            />
          </div>
        );
      })}
      <ToolButton
        icon={<Plus />}
        label="Open another shell"
        onClick={openTab}
        busy={opening}
        size="xs"
        className="size-5 p-0"
      />
    </div>
  );
}

/** The window itself, once there is anything to put in it. */
function TabbedTerminal() {
  const { showing, tabs, active, hide } = useTerminalShells();
  // Nothing at all until a shell has been opened; after that it stays, because
  // what is in it is attached to something that is still running.
  if (!showing && !tabs.length) return null;

  return (
    <TerminalWindow title="Terminal" onClose={hide} className={cn(!showing && 'hidden')}>
      <div className="flex h-full flex-col">
        <TabStrip />
        <div className="relative min-h-0 flex-1">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              data-testid="terminal-tab-body"
              data-shell={tab.id}
              // The attribute as well as the class, so that the tab is hidden
              // by the page's own rules and not only by ours.
              hidden={tab.id !== active}
              className={cn('absolute inset-0', tab.id !== active && 'hidden')}
            >
              <TerminalPane shellId={tab.id} />
            </div>
          ))}
        </div>
      </div>
    </TerminalWindow>
  );
}

/**
 * The app's shells and the window they are drawn in, wrapped around everything.
 *
 * One mount, in the root layout, because there is one window however many
 * screens can open it. The window draws itself into the body wherever it is
 * written, so where this sits in the tree decides nothing but who can reach the
 * context — which is everybody.
 */
export function Terminals({ children }: { children: ReactNode }) {
  return (
    <TerminalShells>
      {children}
      <TabbedTerminal />
    </TerminalShells>
  );
}
