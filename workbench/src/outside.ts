/**
 * The folder the tools write their conversations into, watched, so a chat
 * begun outside this app turns up in the list on its own.
 *
 * A conversation started in Zed, or in a terminal, is written straight to disk
 * by the tool that started it; nothing tells this app it happened. The list is
 * only built when a screen asks for it — `restoreList`, once, on mount — so a
 * chat begun elsewhere sat unlisted until the reader clicked something that
 * happened to fetch the list again, and then the whole day's chats appeared at
 * once. The manager's words for it: "adding a chat in Zed doesn't automatically
 * add it there until we click on a chat, then all the chats update" (bw-uivp).
 *
 * So the folder is watched, and everybody on the app-wide stream is told the
 * one word: the tools' own session folders changed, ask for the list again.
 * Nothing about WHICH chat rides along. `restoreList` in registry.ts is the one
 * place that builds rows and it stays that way — a watcher that started
 * assembling rows of its own would be a second answer to the same question,
 * free to disagree with the first (bw-uivp.1).
 *
 * **The folder is the one the SDK itself reads.** Conversations live at
 * `<config>/projects/<the working directory with its slashes turned to
 * dashes>/<conversation id>.jsonl`, under the same config directory the running
 * markers are read from — `CLAUDE_CONFIG_DIR` when it is set, `~/.claude`
 * otherwise (running.ts, `claudeConfigDir`). Measured rather than assumed: a
 * config directory holding one hand-written file at exactly that path was
 * listed by the SDK's own `listSessions`, so what is watched here is what the
 * list is built from. `record-tail.ts` finds a single chat's record the same
 * way, by listing the same folder.
 *
 * **Both halves of the signal need the recursive watch.** A new conversation
 * appears as a new file inside a project's folder, and a chat somebody is
 * working in appears as an append to a file already there. Only the first of
 * those touches a folder, so nothing shallower than a watch of the whole tree
 * hears an agent still typing.
 *
 * **Cost, measured on the manager's machine.** 1088 folders and 9907 records
 * under `projects`, which the recursive watch turns into about eleven thousand
 * kernel watches on one descriptor: 62ms to establish and some 39 megabytes
 * resident, against a ceiling here of 246896 watches. It is the sidecar's
 * largest single piece of memory and it buys the only signal there is — the
 * tools answer to their own terminals, not to us, and there is no event to
 * subscribe to. A machine whose ceiling is lower than its transcript count
 * refuses the watch, which is a state this degrades through rather than dies
 * of.
 */
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

import { claudeConfigDir } from './running.ts';

/**
 * How long the folder is left to settle before the word is said.
 *
 * An agent mid-turn writes its record constantly — one append per message, and
 * a turn is many messages — and nineteen writes landed in twenty seconds on
 * this machine with the ordinary day's agents running. A frame per write would
 * be a stream of them and a refetch of the whole list behind each. One second
 * is under what a person notices between starting a chat elsewhere and seeing
 * it appear, and it collapses any burst, however long, into one word a second.
 */
const SETTLE_MS = 1_000;

const watchers = new Set<() => void>();
let folder: FSWatcher | null = null;
let settling: ReturnType<typeof setTimeout> | null = null;

/** The word itself, to everybody watching, and the burst starts counting again. */
function tellEverybody(): void {
  settling = null;
  watchers.forEach((tell) => tell());
}

/**
 * Something was written under the folder. The first write in a quiet moment
 * starts the second; every write that lands inside it is already accounted
 * for, so it changes nothing and costs nothing.
 */
function stirred(): void {
  if (settling) return;
  settling = setTimeout(tellEverybody, SETTLE_MS);
}

/**
 * The watch, or nothing at all.
 *
 * A machine where the tool has never run has no `projects` folder, which is an
 * ordinary state and not an error: there are no chats begun elsewhere to hear
 * about. The same is true of a folder that cannot be watched — too many
 * records for the kernel's ceiling, or a permission that says no. In every one
 * of those the sidecar starts and serves exactly as it did before this, which
 * is the promise the whole workbench is held to: the board half of the app
 * works with no workbench at all.
 */
function beginWatching(): FSWatcher | null {
  const projects = join(claudeConfigDir(), 'projects');
  try {
    const watching = watch(projects, { recursive: true }, stirred);
    // The walk that sets the watch up runs on after this returns, so a refusal
    // can arrive late. It is the same answer either way: stop watching, say
    // nothing, and leave the list exactly as good as it was.
    watching.on('error', () => {
      watching.close();
      if (folder === watching) folder = null;
    });
    return watching;
  } catch {
    return null;
  }
}

/**
 * Tells the caller whenever the tools' own session folders change, no more
 * than once a second.
 *
 * One watch for every browser on the stream rather than one each — eleven
 * thousand kernel watches is not a thing to hold a second copy of — and none at
 * all when nobody is connected. A folder that could not be watched is tried
 * again the next time somebody connects, so a machine where the tool ran for
 * the first time after the sidecar started is not deaf until it restarts.
 */
export function watchOutside(tell: () => void): () => void {
  watchers.add(tell);
  if (!folder) folder = beginWatching();
  return () => {
    watchers.delete(tell);
    if (watchers.size > 0) return;
    if (settling) {
      clearTimeout(settling);
      settling = null;
    }
    folder?.close();
    folder = null;
  };
}
