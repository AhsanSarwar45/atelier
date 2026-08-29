/**
 * Every shell the app is holding, and whether the window they live in is showing.
 *
 * The shells belong to the app rather than to any one screen: the button that
 * opens them is on the first bar of every screen that has one, and pressing it
 * on the board and again in the chat has to find the same shells with the same
 * things still running in them. So the list lives here, in a context mounted
 * around the whole app in `src/app/layout.tsx`, and the window with its tabs
 * (`terminal-tabs.tsx`) is a view of it.
 *
 * Nothing in this file draws anything, and that is deliberate rather than tidy:
 * `src/components/shell.tsx` draws the button, and the window's chrome reaches
 * back into the shell for `ToolButton`. A context that imported either of them
 * would close that circle.
 *
 * ## Closing the window does not close the shells
 *
 * `hide` sets a boolean and does nothing else. The only DELETE in this file is
 * in `closeTab`, which is the cross on one tab and the only way a person can
 * say they are finished with a shell. That is the entire feature: a shell
 * outlives every socket that ever watched it (`server/src/terminal/routes.rs`),
 * so a build running in a window somebody shut is still running when they open
 * it again. A window that killed what was inside it on the way out would make
 * the persistence underneath it pointless.
 *
 * ## The server's list is what a reload rebuilds from
 *
 * Nothing about the tabs is written down in the browser. The first time the
 * window is shown in a page's life it asks `GET /api/terminal` and believes the
 * answer: one tab for each shell that has not ended, in the order the server
 * gives them, which is the order they were started in. Ids remembered in local
 * storage would mean a tab drawn for a shell that died while the page was
 * closed, attached to a socket that will never open, with nothing to tell that
 * apart from a slow one.
 *
 * A shell the server lists as ended is not restored. It still holds the last of
 * what it printed, which is worth something, but not enough to hand somebody a
 * tab they cannot type into and cannot tell from the live ones beside it.
 *
 * ## The folder a new shell starts in
 *
 * A screen showing a project says which folder it is showing with
 * `useShowingFolder`, and a new shell starts there. With no project on screen
 * the key is left out of the request altogether and the server starts the shell
 * in the person's home, which is what a shell opened anywhere else on this
 * machine would do.
 *
 * It is kept in a ref rather than in state because nothing draws it: it is read
 * once, at the moment a shell is opened, and a project appearing on screen has
 * no business re-rendering every terminal in the app.
 *
 * ## Why the list is kept in a ref as well as in state
 *
 * Opening, closing and restoring are all asynchronous, and each of them has to
 * act on the list as it is when its answer arrives rather than as it was when
 * it was called. `held` and `chosen` are that list; the state beside them is
 * what the window draws from. One helper writes both, so the two cannot drift.
 */
'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { toast } from '@/hooks/use-toast';
import { request } from '@/lib/api';

/** One shell the app is holding a tab for. */
export type Shell = {
  /** As `POST /api/terminal` named it, and what the pane opens its socket on. */
  id: string;
  /**
   * The folder it was started in, or null when none was named and the server
   * chose home. It is what the tab is called, and it is never guessed at: for a
   * shell this page opened it is the folder this page asked for, and for one
   * restored after a reload it is the folder the server says it started in.
   */
  folder: string | null;
};

/** One shell as `GET /api/terminal` says it. */
type Listed = { id: string; cwd: string; started: string; exited: boolean };

/**
 * The grid a shell is opened at, before anything has been laid out.
 *
 * The request has to carry a shape — a pseudo-terminal is opened with one — but
 * this is not the shape the shell will keep. The pane measures its own box the
 * moment it has one and sends the real answer over the socket
 * (`terminal-pane.tsx`), so what matters here is only that it is the ordinary
 * eighty by twenty-four rather than a nonsense a program could draw itself for.
 */
const OPENING_SHAPE = { cols: 80, rows: 24 };

interface Terminals {
  /** Is the window showing? Shells stay open whatever the answer. */
  showing: boolean;
  tabs: Shell[];
  /** Which tab is in front, or null when there are none. */
  active: string | null;
  /** Is a shell being started right now? */
  opening: boolean;
  show: () => void;
  hide: () => void;
  select: (id: string) => void;
  openTab: () => void;
  closeTab: (id: string) => void;
  /** What folder the screen is showing, or null when it is showing none. */
  showFolder: (folder: string | null) => void;
}

/**
 * What a screen drawn with no provider around it sees: no shells, and controls
 * that do nothing. Every screen in the app is inside the provider, but a screen
 * on a test bench is often drawn on its own, and a button that throws there is a
 * button that fails a case about something else entirely.
 */
const nothingOpen: Terminals = {
  showing: false,
  tabs: [],
  active: null,
  opening: false,
  show: () => {},
  hide: () => {},
  select: () => {},
  openTab: () => {},
  closeTab: () => {},
  showFolder: () => {},
};

const Shells = createContext<Terminals>(nothingOpen);

export function useTerminalShells(): Terminals {
  return useContext(Shells);
}

/**
 * The screen says which folder it is showing, for as long as it is showing it.
 *
 * Cleared on the way out, so a shell opened from the project list — or from a
 * screen that shows no folder at all — starts at home rather than in whatever
 * project happened to be open last.
 */
export function useShowingFolder(folder: string | null): void {
  const { showFolder } = useTerminalShells();
  useEffect(() => {
    showFolder(folder || null);
    return () => showFolder(null);
  }, [folder, showFolder]);
}

/**
 * Every shell the server still has, oldest first.
 *
 * Asked through `request` rather than the browser's own `fetch`, like every
 * other question this app puts to the app behind it (`src/lib/api.ts`): that is
 * the one place that knows where the app is and how long is too long to wait
 * for an answer, and a shell list left out of it would be the one read in the
 * app that hangs forever when the server is wedged.
 */
async function listShells(): Promise<Listed[]> {
  const answer = await request('/api/terminal');
  if (!answer.ok) throw new Error(await answer.text());
  return (await answer.json()) as Listed[];
}

async function openShell(folder: string | null): Promise<string> {
  const answer = await request('/api/terminal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // The key is left out rather than sent empty when no project is on screen:
    // an absent folder is what tells the server to choose home, and a folder it
    // has to interpret is one it can be wrong about.
    body: JSON.stringify(folder ? { cwd: folder, ...OPENING_SHAPE } : { ...OPENING_SHAPE }),
  });
  if (!answer.ok) throw new Error(await answer.text());
  return ((await answer.json()) as { id: string }).id;
}

async function closeShell(id: string): Promise<void> {
  const answer = await request(`/api/terminal/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!answer.ok) throw new Error(await answer.text());
}

/**
 * What went wrong, in the words it was said in.
 *
 * The server answers a refusal with a sentence written for the person rather
 * than a code (`server/src/terminal/routes.rs`), so it is passed on whole. A
 * failure swallowed here is a button that does nothing twice.
 */
function complain(what: string, why: unknown): void {
  const said = (why instanceof Error ? why.message : String(why)).trim();
  toast({ title: what, description: said || undefined, variant: 'destructive' });
}

export function TerminalShells({ children }: { children: ReactNode }) {
  const [showing, setShowing] = useState(false);
  const [tabs, setTabs] = useState<Shell[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const held = useRef<Shell[]>([]);
  const chosen = useRef<string | null>(null);
  const folder = useRef<string | null>(null);
  /** Has the server been asked what it has, in this page's life? Once is enough. */
  const asked = useRef(false);
  /** Is the window's first fill under way, so it is not started twice? */
  const filling = useRef(false);

  const keep = useCallback((next: Shell[]) => {
    held.current = next;
    setTabs(next);
  }, []);

  const choose = useCallback((id: string | null) => {
    chosen.current = id;
    setActive(id);
  }, []);

  const openTab = useCallback(async () => {
    setOpening(true);
    try {
      // Read now rather than when the answer comes back: this is the folder the
      // person was looking at when they asked for a shell.
      const startingIn = folder.current;
      const id = await openShell(startingIn);
      keep([...held.current, { id, folder: startingIn }]);
      choose(id);
    } catch (why) {
      complain('The shell would not start', why);
    } finally {
      setOpening(false);
    }
  }, [keep, choose]);

  const closeTab = useCallback(
    async (id: string) => {
      const was = held.current;
      const left = was.filter((tab) => tab.id !== id);
      keep(left);
      if (chosen.current === id) {
        // The one on its left, which is where the eye already is; the first one
        // when the tab that went was itself the first.
        const gone = was.findIndex((tab) => tab.id === id);
        choose(left[Math.max(0, gone - 1)]?.id ?? null);
      }
      // Nothing left to show. The window is not a thing to sit and look at
      // empty, and re-opening it starts a shell the way the first one did.
      if (!left.length) setShowing(false);
      // The tab goes first and the shell after it, so the pane has let go of
      // its socket before the shell it was watching is taken away.
      try {
        await closeShell(id);
      } catch (why) {
        complain('The shell would not close', why);
      }
    },
    [keep, choose],
  );

  const show = useCallback(() => setShowing(true), []);
  // Every word of the decision is in the file's own note: this closes a window,
  // not a shell, and there is no DELETE anywhere near it.
  const hide = useCallback(() => setShowing(false), []);

  const showFolder = useCallback((where: string | null) => {
    folder.current = where || null;
  }, []);

  /**
   * A window shown with nothing in it fills itself: from the server the first
   * time, because a reload has to find the shells it left running, and with a
   * new shell after that.
   *
   * Guarded by a ref rather than by what is in the list, so that a shell that
   * refuses to start is not asked for again and again by an effect watching the
   * empty list it left behind.
   */
  useEffect(() => {
    if (!showing) {
      filling.current = false;
      return;
    }
    if (filling.current || held.current.length) return;
    filling.current = true;
    void (async () => {
      if (!asked.current) {
        asked.current = true;
        try {
          const said = await listShells();
          const live = said
            .filter((one) => !one.exited)
            .map((one) => ({ id: one.id, folder: one.cwd || null }));
          if (live.length) {
            keep(live);
            // The last one started is the one they were most likely in.
            choose(live[live.length - 1].id);
            return;
          }
        } catch (why) {
          complain('The shells already running could not be listed', why);
        }
      }
      await openTab();
    })();
  }, [showing, keep, choose, openTab]);

  return (
    <Shells.Provider
      value={{
        showing,
        tabs,
        active,
        opening,
        show,
        hide,
        select: choose,
        openTab: () => void openTab(),
        closeTab: (id: string) => void closeTab(id),
        showFolder,
      }}
    >
      {children}
    </Shells.Provider>
  );
}
