/**
 * The project screen's address, in one place.
 *
 * Everything a reader could arrive at is in the address and nothing that a link
 * could carry is held in a component's own state:
 *
 *   /project?id=<project>&tab=chat|tasks|files&chat=<sessionId>
 *   …&file=<absolute path>&line=<1-based line>
 *   …&message=<id>                            a search's jump into the chat, dropped once made
 *   …&diff=<@diff id>                          a diff to show, dropped once shown
 *   …&task=<number>                            the task open in the Tasks tab's detail panel
 *   …&newchat=task                             open the New chat dialog; the chat it starts gets `@task `
 *   …&settings=<section>&ptab=<provider tab>   the project's settings, over the top
 *   …&pitem=<plugin or server>                 the page of one item on that tab
 *
 * Design: docs/designs/app-shell.md §1.7.
 */

export type Tab = 'chat' | 'tasks' | 'files';

export interface Where {
  /** The project. Null only while the screen is being sent back to the list. */
  id: string | null;
  tab: Tab;
  /** The conversation drawn in the chat tab. */
  chat: string | null;
  /**
   * The address still names the retired board (`tab=board`) or one of its
   * cards (`card=`, or the older `bead=`). The screen shows Tasks and rewrites
   * the address without them.
   */
  retired: boolean;
  /** The file the Files tab is showing, as an absolute path. */
  file: string | null;
  /** The line of that file to scroll to and mark, counted from one. */
  line: number | null;
  /** The message a search opens the chat at. Dropped once the chat is there. */
  message: string | null;
  /**
   * A diff to show, written as a `@diff:` reference's id. The tab it lands in
   * opens it and drops it from the address, the way `message` is dropped.
   */
  diff: string | null;
  /** The task whose detail the Tasks tab shows, by its number. */
  task: number | null;
  /**
   * `task` asks the chat tab to open its New chat dialog and put `@task ` in
   * the chat it starts (the Tasks tab's New task button). Dropped once read.
   */
  newchat: string | null;
  /** The project settings section drawn over the screen, or nothing. */
  settings: string | null;
  /** The provider tab inside a settings section. */
  ptab: string | null;
  /** The plugin or MCP server whose page is open on that tab. */
  pitem: string | null;
}

/**
 * The line the address names, or null when it names none worth having.
 *
 * A file's lines start at one, so `0`, `-3`, `2.5` and `banana` are all
 * somebody's slip; a viewer told to scroll to any of them would either throw or
 * quietly land somewhere else and say nothing.
 */
export function lineFrom(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const line = Number(raw);
  return Number.isInteger(line) && line > 0 ? line : null;
}

/** The parts of an address the retired board used. Read once, never written. */
const RETIRED = ['card', 'bead'] as const;

/** Where the address says we are. */
export function whereFrom(params: URLSearchParams): Where {
  const chat = params.get('chat');
  const file = params.get('file');
  const rawTab = params.get('tab');
  // Naming a file asks for the Files tab, the same way naming a chat asks for
  // the Chat tab: a link that carries one lands where the thing it carries can
  // actually be seen, without every writer of a link having to spell the tab
  // out as well. An address that names no tab, or an unknown or retired one,
  // opens on the tasks: that is where a project's work is kept. A named chat
  // still opens the chat it names.
  const tab: Tab =
    rawTab === 'chat'
      ? 'chat'
      : rawTab === 'tasks'
        ? 'tasks'
        : rawTab === 'files'
          ? 'files'
          : rawTab === 'board'
            ? 'tasks'
            : file
              ? 'files'
              : chat
                ? 'chat'
                : 'tasks';
  return {
    id: params.get('id'),
    tab,
    chat,
    retired: rawTab === 'board' || RETIRED.some((key) => params.has(key)),
    file,
    line: lineFrom(params.get('line')),
    message: params.get('message'),
    diff: params.get('diff'),
    task: lineFrom(params.get('task')),
    newchat: params.get('newchat'),
    settings: params.get('settings'),
    ptab: params.get('ptab'),
    pitem: params.get('pitem'),
  };
}

/**
 * The same address with some of it changed. Everything else it carries is kept,
 * so a parameter this file has never heard of survives a tab switch; `null`
 * removes one.
 */
export function addressWith(params: URLSearchParams, patch: Partial<Omit<Where, 'retired'>>): string {
  const q = new URLSearchParams(params.toString());
  // The retired board's parts are dropped on the way out, so one address shape
  // leaves this screen however the reader arrived at it.
  for (const key of RETIRED) q.delete(key);
  if (q.get('tab') === 'board') q.set('tab', 'tasks');
  // `line` is a number where every other part is a string; both are written as
  // the text a reader would have typed into the address bar themselves.
  for (const [key, value] of Object.entries(patch) as [keyof Where, string | number | null][]) {
    if (value === null || value === undefined || value === '') q.delete(key);
    else q.set(key, String(value));
  }
  return `/project?${q.toString()}`;
}

/**
 * Whether the app has a page of its own behind this one.
 *
 * The bar's arrow is a step back through the history, not a jump to the list:
 * a nested page opened from a chat has to give that chat back, not the front door.
 * It falls back to the list only when nothing of ours is behind — a pasted
 * address, a fresh tab — because stepping back there would leave the app.
 *
 * The Navigation API is the exact answer: its entries are only the ones on this
 * origin, so an index above the first means the entry behind us is ours.
 * Browsers without it get the rough count, which is right about the fresh tab
 * and wrong only about arriving from somewhere else, where stepping back is
 * what the browser's own arrow would do anyway.
 */
export function somewhereBehind(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = (window as { navigation?: { currentEntry?: { index: number } } }).navigation;
  if (nav?.currentEntry) return nav.currentEntry.index > 0;
  return window.history.length > 1;
}

/**
 * How many entries back the nearest one that `leaves` says is outside a
 * screen is — the arrow that closes a screen drawn over the address steps over
 * every section and tab it pushed, wherever the reader has since stepped to.
 *
 * The Navigation API is asked first: it knows every entry of ours and their
 * addresses. Without it the caller's own count is used, which is right until
 * the reader presses Back inside the screen and then the arrow.
 */
export function stepsOut(leaves: (url: URL) => boolean, counted: number): number {
  if (typeof window === 'undefined') return counted;
  const nav = (window as { navigation?: { currentEntry?: { index: number }; entries(): { url: string | null }[] } }).navigation;
  if (!nav?.currentEntry) return counted;
  const entries = nav.entries();
  for (let i = nav.currentEntry.index - 1; i >= 0; i -= 1) {
    const url = entries[i]?.url;
    if (!url) continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.origin !== window.location.origin) return 0;
    if (leaves(parsed)) return nav.currentEntry.index - i;
  }
  return 0;
}

/**
 * Shows a task's detail, or closes it, in place: the address is rewritten
 * rather than pushed, so picking through the list does not fill the history,
 * and Back leaves the Tasks tab the way it leaves any other. Next follows the
 * native history, so the screen reads the new address like any other — but
 * only for a call that does not hand it Next's own entry state: given that
 * (`window.history.state`), Next takes the call for its own and leaves
 * `useSearchParams` on the old address, so the detail never opened. `null`
 * is the state Next keeps its own entry under and follows.
 */
export function showTask(params: URLSearchParams, task: number | null): void {
  window.history.replaceState(null, '', addressWith(params, { tab: 'tasks', task }));
}
