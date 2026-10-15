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
 * ## Each project sees its own shells
 *
 * A shell belongs to the project whose screen opened it, and its tab is drawn
 * only on that project's screens; a shell opened where no project is showing
 * belongs to those screens instead. The server keeps the project beside the
 * shell and hands it back in the list (`server/src/terminal/routes.rs`), so a
 * reload puts every tab back where it was opened. It is not worked out from the
 * folder a shell started in: "Open in terminal" starts one in any folder of a
 * project, and a project's folder can sit inside another project's.
 *
 * A shell on another project's screen is only out of sight. Its pane stays
 * mounted with the rest (`terminal-tabs.tsx`), so whatever runs in it keeps
 * running and keeps its screen. Each project remembers its own front tab, and
 * moving to a project with no shells closes the window rather than starting one
 * nobody asked for.
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
  useMemo,
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
  /** The folder of the project whose screens show it, or null for the screens showing none. */
  project: string | null;
};

/** One shell as `GET /api/terminal` says it. */
type Listed = { id: string; cwd: string; project?: string | null; started: string; exited: boolean };

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
  /** The shells of the project on screen, which are the tabs on the strip. */
  tabs: Shell[];
  /**
   * Every shell held, on every project's screens. The window keeps a pane
   * mounted for each, so a shell out of sight is still attached.
   */
  kept: Shell[];
  /** Which tab is in front, or null when there are none. */
  active: string | null;
  /** Is a shell being started right now? */
  opening: boolean;
  show: () => void;
  hide: () => void;
  select: (id: string) => void;
  openTab: () => void;
  /**
   * A shell at a folder somebody named, rather than at whatever the screen is
   * showing: what "Open in terminal" on a path menu asks for
   * (`path-menu.tsx`). Separate from `openTab` rather than an argument to it,
   * because `openTab` is handed straight to an `onClick` and would be given a
   * mouse event to start a shell in.
   */
  openAt: (folder: string) => void;
  closeTab: (id: string) => void;
  /** What folder the screen is showing, or null when it is showing none. */
  showFolder: (folder: string | null) => void;
  /**
   * A pane offering to type into its shell, or taking the offer back.
   *
   * The socket belongs to the pane and nothing here is going to take it away:
   * `terminal-pane.tsx` builds it and tears it down in one effect, and that
   * arrangement is what keeps a hidden tab's shell attached. So a caller who
   * wants a line typed asks through here and the pane does the typing.
   */
  offerTyping: (id: string, type: ((text: string) => void) | null) => void;
  /**
   * Puts a line at the prompt of the shell in `id`, exactly as if it had been
   * typed. No return is added: what arrives sits on the prompt to be read,
   * corrected or run, and the decision to run it stays with the person. A list
   * of old commands is a list of things that were worth doing once, and one
   * `rm -rf` reached by a fuzzy match and a stray click is the reason.
   *
   * Answers whether anything received it, so a caller can say so rather than
   * appear to have worked.
   */
  typeInto: (id: string, text: string) => boolean;
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
  kept: [],
  active: null,
  opening: false,
  show: () => {},
  hide: () => {},
  select: () => {},
  openTab: () => {},
  openAt: () => {},
  closeTab: () => {},
  showFolder: () => {},
  offerTyping: () => {},
  typeInto: () => false,
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

async function openShell(folder: string | null, project: string | null): Promise<string> {
  const answer = await request('/api/terminal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // The key is left out rather than sent empty when no project is on screen:
    // an absent folder is what tells the server to choose home, and a folder it
    // has to interpret is one it can be wrong about.
    body: JSON.stringify({
      ...(folder ? { cwd: folder } : {}),
      ...(project ? { project } : {}),
      ...OPENING_SHAPE,
    }),
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

/** Where a project's front tab is remembered; the screens showing no project share one. */
const pickKey = (project: string | null) => project ?? '';

/**
 * Which of a project's shells is in front: the one last chosen there, or the
 * newest when that one is gone or none was chosen.
 */
function frontOf(all: Shell[], project: string | null, picks: Record<string, string>): string | null {
  const theirs = all.filter((tab) => tab.project === project);
  const picked = picks[pickKey(project)];
  if (theirs.some((tab) => tab.id === picked)) return picked;
  return theirs[theirs.length - 1]?.id ?? null;
}

export function TerminalShells({ children }: { children: ReactNode }) {
  const [showing, setShowing] = useState(false);
  const [kept, setKept] = useState<Shell[]>([]);
  const [where, setWhere] = useState<string | null>(null);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [opening, setOpening] = useState(false);

  const held = useRef<Shell[]>([]);
  const picked = useRef<Record<string, string>>({});
  const folder = useRef<string | null>(null);
  /** Has the server been asked what it has, in this page's life? Once is enough. */
  const asked = useRef(false);
  /** Is the window's first fill under way, so it is not started twice? */
  const filling = useRef(false);
  /** How many shells are being started right now; their tabs are not on the list yet. */
  const starting = useRef(0);

  const keep = useCallback((next: Shell[]) => {
    held.current = next;
    setKept(next);
  }, []);

  const choose = useCallback((project: string | null, id: string | null) => {
    const next = { ...picked.current };
    if (id) next[pickKey(project)] = id;
    else delete next[pickKey(project)];
    picked.current = next;
    setPicks(next);
  }, []);

  const tabs = useMemo(() => kept.filter((tab) => tab.project === where), [kept, where]);
  const active = frontOf(kept, where, picks);

  /**
   * Start one shell and put a tab in front for it.
   *
   * `at` is a folder somebody named; null means the folder the screen is
   * showing, which is what the `+` on the window means.
   */
  const start = useCallback(
    async (at: string | null) => {
      setOpening(true);
      starting.current += 1;
      try {
        // Read now rather than when the answer comes back: this is the folder the
        // person was looking at when they asked for a shell.
        const project = folder.current;
        const startingIn = at ?? project;
        const id = await openShell(startingIn, project);
        keep([...held.current, { id, folder: startingIn, project }]);
        choose(project, id);
      } catch (why) {
        complain('The shell would not start', why);
      } finally {
        starting.current -= 1;
        setOpening(false);
      }
    },
    [keep, choose],
  );

  const openTab = useCallback(() => void start(null), [start]);

  const closeTab = useCallback(
    async (id: string) => {
      const closing = held.current.find((tab) => tab.id === id);
      if (!closing) return;
      const { project } = closing;
      const was = held.current.filter((tab) => tab.project === project);
      const left = was.filter((tab) => tab.id !== id);
      const wasInFront = frontOf(held.current, project, picked.current) === id;
      keep(held.current.filter((tab) => tab.id !== id));
      if (wasInFront) {
        // The one on its left, which is where the eye already is; the first one
        // when the tab that went was itself the first.
        const gone = was.findIndex((tab) => tab.id === id);
        choose(project, left[Math.max(0, gone - 1)]?.id ?? null);
      }
      // Nothing left to show. The window is not a thing to sit and look at
      // empty, and re-opening it starts a shell the way the first one did.
      if (!left.length && project === folder.current) setShowing(false);
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

  const showFolder = useCallback((shown: string | null) => {
    const next = shown || null;
    if (next === folder.current) return;
    folder.current = next;
    setWhere(next);
  }, []);

  /**
   * A project with no shells of its own gets no window, rather than an empty
   * one that starts a shell the moment it is drawn.
   *
   * Decided once the move has settled rather than in `showFolder`: moving
   * between two projects clears the folder on the way out before the next
   * screen names its own, and a window judged on that passing null would close
   * on every move between two projects that both have shells.
   */
  useEffect(() => {
    if (starting.current) return;
    if (!held.current.some((tab) => tab.project === where)) setShowing(false);
  }, [where]);

  /**
   * A window shown with nothing in it fills itself: from the server the first
   * time, because a reload has to find the shells it left running, and with a
   * new shell after that.
   *
   * Guarded by a ref rather than by what is in the list, so that a shell that
   * refuses to start is not asked for again and again by an effect watching the
   * empty list it left behind.
   */
  /**
   * Take over whatever the server is still holding, once in a page's life, and
   * say whether it found any.
   *
   * Pulled out of the effect below because opening a shell at a named folder
   * has to do it too: a reader who asks for a terminal at `src/` before the
   * window has ever been shown should still get back the shells that were
   * running before the page was loaded, and not only the one they just asked
   * for.
   */
  const adopt = useCallback(async () => {
    if (asked.current) return false;
    asked.current = true;
    try {
      const said = await listShells();
      const live = said
        .filter((one) => !one.exited)
        .map((one) => ({ id: one.id, folder: one.cwd || null, project: one.project || null }));
      if (!live.length) return false;
      // Each project's front tab is its newest, which is the one they were
      // most likely in, so nothing needs choosing here.
      keep(live);
      return live.some((one) => one.project === folder.current);
    } catch (why) {
      complain('The shells already running could not be listed', why);
      return false;
    }
  }, [keep]);

  /**
   * A shell at a folder a menu named, with the window brought up around it.
   *
   * `filling` is claimed before the window is shown, so the effect below sees
   * this fill already under way and does not start a second shell at the wrong
   * folder beside it.
   */
  const openAt = useCallback(
    (where: string) => {
      filling.current = true;
      setShowing(true);
      void (async () => {
        await adopt();
        await start(where);
      })();
    },
    [adopt, start],
  );

  useEffect(() => {
    if (!showing) {
      filling.current = false;
      return;
    }
    if (filling.current || held.current.some((tab) => tab.project === folder.current)) return;
    filling.current = true;
    void (async () => {
      if (!(await adopt())) await start(null);
    })();
  }, [showing, adopt, start]);

  /**
   * Which pane will type for which shell.
   *
   * A ref and not state: nothing on the screen changes when a pane offers or
   * withdraws, and making it state would rerender every tab each time one
   * mounted. It is written during an effect and read from an event handler,
   * which is the shape a ref is for.
   */
  const typists = useRef(new Map<string, (text: string) => void>());

  const offerTyping = useCallback((id: string, type: ((text: string) => void) | null) => {
    if (type) typists.current.set(id, type);
    else typists.current.delete(id);
  }, []);

  const typeInto = useCallback((id: string, text: string) => {
    const type = typists.current.get(id);
    if (!type) return false;
    type(text);
    return true;
  }, []);

  return (
    <Shells.Provider
      value={{
        showing,
        tabs,
        kept,
        active,
        opening,
        show,
        hide,
        select: (id: string) => choose(where, id),
        openTab,
        openAt,
        closeTab: (id: string) => void closeTab(id),
        showFolder,
        offerTyping,
        typeInto,
      }}
    >
      {children}
    </Shells.Provider>
  );
}
