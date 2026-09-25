/**
 * Typing `@` in the composer offers the files of the checkout (bw-gr8y.7), and
 * beside them Atelier's own things: cards, chats and skills (bw-mi3s.4).
 *
 * One question per keystroke, `/api/workbench/mention`, answers all four kinds
 * at once from what the server already holds, grouped by kind with the best
 * group first. Typing `@bead:`, `@chat:` or `@skill:` narrows the menu to that
 * kind. Picking a card, chat or skill writes `@kind:id`, which the composer
 * draws at once as the badge the sent message will draw.
 *
 * This is the seam `composer-editor.tsx` left open: a CodeMirror completion
 * source, handed in as `extra`, that turns an `@` into the menu every coding
 * harness has trained the reader to expect — a fuzzy search of the worktree,
 * the file's own icon beside its name, and the folder it sits in written dimly
 * after it.
 *
 * ## What is decided here and what is decided on the server
 *
 * Almost nothing about *ranking* is decided here. `/api/fs/find` walks the tree
 * once with git's ignore rules obeyed, keeps the listing, and scores what was
 * typed against it — a hit in the file's own name before a hit anywhere in its
 * path, and the shorter path when two are otherwise equal. So the order the
 * server sends is the order the menu shows, and this file passes
 * `filter: false` to say so. CodeMirror's own filter would re-sort the answer
 * by its own idea of a good match and quietly undo the whole ranking.
 *
 * What is decided here is what an `@` *is* — and that is not decided here
 * either. The characters go in through `formatReference`, the one grammar
 * (`references.ts`), so a reference the menu inserts is the same reference the
 * transcript draws, the file viewer copies, and the parser reads back.
 *
 * ## Why the root arrives as a function
 *
 * `extra` is read once, when the view is built, and the folder a chat works in
 * is not known then: it arrives with the session facts a moment later, and it
 * is the chat's own worktree rather than the project's checkout. So the root is
 * asked for at the moment of the keystroke instead of captured at build.
 */

import {
  acceptCompletion,
  autocompletion,
  completionKeymap,
  completionStatus,
  setSelectedCompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { Prec, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap, tooltips, type ViewUpdate } from '@codemirror/view';

import { iconForFile, iconForFolder } from '@/components/file-icon';
import { ICON_FALLBACK, iconUrl } from '@/components/file-icons';
import { referenceBadgeElement, type Reference } from '@/components/reference-badge';
import { mention, type FsFoundPath, type MentionOffer, type MentionPlace } from '@/lib/api';
import type { BeadStatus } from '@/types';
import type { Brand, CommandInfo } from '@/workbench/protocol';
import { learnChat, learnSkill, setReferenceAsker } from '@/workbench/reference-names';
import { canBeginReference, formatAtelierReference, formatReference, type AtelierKind } from '@/workbench/references';

/** How many the menu ever shows. Past this nobody is reading, he is typing. */
const MOST_OFFERED = 20;

/**
 * The characters that still belong to the reference being typed.
 *
 * Whitespace ends it, and so does a second `@`, so `me@example.com` never opens
 * a menu behind the cursor. A quote ends it too: `@"a name with spaces"` is a
 * shape the grammar allows but not one anybody types a search into.
 */
// The backtick is written as `\x60` so no scan of this file for quoted words
// mistakes it for the start of a template string.
const TYPING = /@[^\s@"'\x60]*$/;

/** The last part of a path, and the folder it sits in. */
function split(path: string): { name: string; folder: string } {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? { name: path, folder: '' } : { name: path.slice(cut + 1), folder: path.slice(0, cut) };
}

/**
 * The entry's own picture, the one the file tree draws for the same file.
 *
 * A name material has nothing for still gets the plain file or folder icon
 * rather than nothing: the tree can fall back to a Lucide glyph because it is
 * React, but a completion row is plain DOM, and a row with no icon at all sits
 * half a centimetre left of every other row in the list.
 */
function picture(found: FsFoundPath): Node {
  const { name } = split(found.path);
  const icon =
    found.kind === 'dir'
      ? (iconForFolder(name, false) ?? ICON_FALLBACK.folder)
      : (iconForFile(name) ?? ICON_FALLBACK.file);
  const drawn = document.createElement('img');
  drawn.src = iconUrl(icon);
  drawn.alt = '';
  drawn.width = 16;
  drawn.height = 16;
  drawn.className = 'cm-fileIcon';
  drawn.setAttribute('aria-hidden', 'true');
  drawn.setAttribute('data-icon', icon);
  return drawn;
}

/** The heading over each kind, and where it sits: the server's order. */
const HEADINGS: Record<MentionOffer['kind'], string> = {
  file: 'Files',
  bead: 'Cards',
  chat: 'Chats',
  skill: 'Skills',
};

/** One found path as a line of the menu. */
function offer(found: FsFoundPath, rank = 0): Completion {
  const { name, folder } = split(found.path);
  const folderish = found.kind === 'dir';
  return {
    // The whole reference, so two files of the same name in different folders
    // are two different options rather than one that keeps its first icon.
    label: `@${found.path}`,
    // What is actually read: the name, big, and where it lives, dimmed.
    displayLabel: folderish ? `${name}/` : name,
    detail: folder,
    type: folderish ? 'folder' : 'file',
    section: { name: HEADINGS.file, rank },
    apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
      const insert = formatReference({
        path: found.path,
        line: null,
        endLine: null,
        kind: folderish ? 'folder' : 'file',
      });
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
      });
      // A folder is a step, not an answer: `@src/` reopens the menu already
      // narrowed into it, which is how typing `/` walks down the tree.
      if (folderish) startCompletion(view);
    },
  };
}

/** What the badge for an offered card, chat or skill draws. */
function referenceOf(found: MentionOffer): Reference {
  const kind = found.kind as AtelierKind;
  if (kind === 'bead') return { kind, id: found.id, status: found.status as BeadStatus | undefined };
  if (kind === 'chat') {
    return { kind, id: found.id, name: found.label, brand: found.brand as Brand | undefined, projectId: found.projectId ?? null };
  }
  return { kind, id: found.id, name: found.label, description: found.detail };
}

/** Remember the names the menu has seen, so the badge a pick writes has one. */
function learn(found: MentionOffer): void {
  if (found.kind === 'chat' && found.brand) {
    learnChat(found.id, { name: found.label, brand: found.brand as Brand, projectId: found.projectId ?? null });
  } else if (found.kind === 'skill') {
    learnSkill(found.id, { name: found.label, description: found.detail || undefined });
  }
}

/**
 * A card, a chat or a skill as a line of the menu: its badge — the very badge
 * picking it writes — and, for a card, its title after it.
 */
function atelierOffer(found: MentionOffer, rank: number): Completion {
  const kind = found.kind as AtelierKind;
  const insert = formatAtelierReference(kind, found.id);
  return {
    label: insert,
    // A card's badge says only its id, so its title is the line's words. A
    // chat's and a skill's badge already say their name.
    displayLabel: kind === 'bead' ? found.label : ' ',
    detail: kind === 'skill' ? found.detail : '',
    type: kind,
    section: { name: HEADINGS[kind], rank },
    apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
      // A space after it, so the badge is finished and drawn the moment it is
      // picked rather than left as words still being typed.
      const written = insert + ' ';
      view.dispatch({ changes: { from, to, insert: written }, selection: { anchor: from + written.length } });
    },
  };
}

/** Everything the server offered, as lines of the menu in its order. */
function lines(found: readonly MentionOffer[]): Completion[] {
  const ranks = new Map<string, number>();
  return found.map((one) => {
    if (!ranks.has(one.kind)) ranks.set(one.kind, ranks.size);
    const rank = ranks.get(one.kind)!;
    learn(one);
    return one.kind === 'file'
      ? offer({ path: one.id, kind: one.folder ? 'dir' : 'file' }, rank)
      : atelierOffer(one, rank);
  });
}

/** The badge for a line of the menu, kept on the line itself for drawing. */
const drawnBadges = new WeakMap<Completion, Reference>();

/**
 * What the menu offers for what has been typed after the `@`.
 *
 * Answers nothing at all unless the cursor really is inside a reference — an
 * `@` that begins one, by the same rule `references.ts` reads text with, so an
 * email address is left alone.
 *
 * Each keystroke's question is cancelled as soon as the next keystroke makes it
 * stale, so a slow answer to `@st` never lands on top of the answer to `@sta`.
 */
function offering(placeOf: () => MentionPlace): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const token = context.matchBefore(TYPING);
    if (!token) return null;
    const before = token.from === 0 ? '' : context.state.sliceDoc(token.from - 1, token.from);
    if (!canBeginReference(before)) return null;

    const place = placeOf();
    if (!place.cwd) return null;

    const stale = new AbortController();
    context.addEventListener('abort', () => stale.abort(), { onDocChange: true });
    let found;
    try {
      found = await mention.search(place, token.text.slice(1), MOST_OFFERED, stale.signal);
    } catch {
      // A checkout that has gone away, or a server that is restarting: the
      // right answer is no menu, not a red line under what he is writing.
      return null;
    }
    if (context.aborted) return null;

    const options = lines(found.items);
    found.items.forEach((one, at) => {
      if (one.kind !== 'file') drawnBadges.set(options[at]!, referenceOf(one));
    });
    return {
      from: token.from,
      options,
      // The server's ranking is the ranking. See the note at the top.
      filter: false,
    };
  };
}

/**
 * Ask the server, a batch at a time, about references a badge was drawn for
 * before anybody here had seen what they name — a draft restored after a
 * reload, a chat from another project.
 */
function askAboutNames(placeOf: () => MentionPlace): (kind: AtelierKind, id: string) => void {
  let waiting: string[] = [];
  return (kind, id) => {
    waiting.push(kind + ':' + id);
    if (waiting.length > 1) return;
    queueMicrotask(() => {
      const ids = waiting;
      waiting = [];
      const place = placeOf();
      mention
        .names(place, ids)
        .then((named) => named.items.forEach(learn))
        .catch(() => {});
    });
  };
}

/**
 * The `/` menu: the install's own commands and skills, on the same engine as
 * the `@` menu (bw-mi3s.5).
 *
 * It opens on a slash at the start of a draft that is one unfinished word, the
 * rule the menu drawn above the box used to follow, and picking one writes it
 * into the box — sending is ordinary, because that is how a command is run
 * (§7). The ranking is fuzzy: what was typed may be the start of the name, the
 * start of a skill's id (`/stand` finds `/skill:standup`), inside the name, or
 * its letters in order.
 */
export interface CommandsNow {
  commands: readonly CommandInfo[];
  /** The provider's own commands are still being asked for (bw-zldt.2). */
  pending: boolean;
}

/**
 * The chat's command list as the menu reads it: what it is now, and word when
 * it changes, because the provider's own commands arrive a beat after the box
 * and a menu already open must show them.
 */
export interface CommandFeed {
  now(): CommandsNow;
  set(next: CommandsNow): void;
  subscribe(listener: () => void): () => void;
}

export function commandFeed(): CommandFeed {
  let current: CommandsNow = { commands: [], pending: false };
  const listeners = new Set<() => void>();
  return {
    now: () => current,
    set: (next) => {
      if (next.commands === current.commands && next.pending === current.pending) return;
      current = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** A whole draft that is one word starting with a slash. */
const SLASH_WORD = /^\/(\S*)$/;

/** How well `typed` answers a command, lower first; null when it does not. */
function commandFit(command: CommandInfo, typed: string): number | null {
  if (!typed) return 3;
  const name = command.name.toLowerCase();
  const id = name.startsWith('skill:') ? name.slice('skill:'.length) : null;
  if (name === typed || id === typed) return 0;
  if (name.startsWith(typed) || id?.startsWith(typed)) return 1;
  if (name.includes(typed)) return 2;
  let at = 0;
  for (const letter of typed) {
    at = name.indexOf(letter, at);
    if (at < 0) return null;
    at += 1;
  }
  return 4;
}

/**
 * The commands that answer what was typed after the slash, best first, and in
 * the order the chat announced them among equals. Unbounded, because the
 * provider's own list can run past any cap on its own, and the Atelier rows
 * come after it, so a cap hid every one of them (bw-zldt.1). The menu scrolls.
 */
export function rankCommands(commands: readonly CommandInfo[], typed: string): CommandInfo[] {
  const wanted = typed.toLowerCase();
  return commands
    .map((command, at) => ({ command, at, fit: commandFit(command, wanted) }))
    .filter((one): one is { command: CommandInfo; at: number; fit: number } => one.fit !== null)
    .sort((a, b) => a.fit - b.fit || a.at - b.at)
    .map((one) => one.command);
}

/** Which command a line of the menu is, kept for drawing it. */
const drawnCommands = new WeakMap<Completion, CommandInfo | 'pending'>();

function commandOffer(command: CommandInfo): Completion {
  const written = '/' + command.name + ' ';
  const line: Completion = {
    label: '/' + command.name,
    type: 'command',
    apply: (view: EditorView) => {
      // Written into the box rather than sent: he may want to add an argument,
      // and a command is ordinary prompt text either way (§7).
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: written },
        selection: { anchor: written.length },
      });
    },
  };
  drawnCommands.set(line, command);
  return line;
}

/** The line that says more commands are on their way. Picking it does nothing. */
function pendingLine(): Completion {
  const line: Completion = { label: '/', type: 'pending', apply: () => {} };
  drawnCommands.set(line, 'pending');
  return line;
}

function commandsOffering(feed: CommandFeed): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const typed = SLASH_WORD.exec(context.state.doc.toString());
    if (!typed || context.pos !== context.state.doc.length) return null;
    const { commands, pending } = feed.now();
    const options = rankCommands(commands, typed[1]!).map(commandOffer);
    if (pending) options.push(pendingLine());
    if (!options.length) return null;
    return { from: 0, options, filter: false };
  };
}

/** One command as the menu draws it: the name, its argument, what it does. */
function drawCommand(command: CommandInfo | 'pending'): HTMLElement {
  const row = document.createElement('span');
  if (command === 'pending') {
    row.setAttribute('data-testid', 'commands-pending');
    row.className = 'cm-commandPending';
    row.textContent = "Loading the provider's commands…";
    return row;
  }
  row.setAttribute('data-testid', 'command-option');
  row.setAttribute('data-command', command.name);
  row.setAttribute('data-kind', command.kind);
  row.className = 'cm-commandRow';
  const name = row.appendChild(document.createElement('span'));
  name.className = 'cm-commandName';
  name.textContent = '/' + command.name;
  if (command.argumentHint) {
    const hint = row.appendChild(document.createElement('span'));
    hint.className = 'cm-commandHint';
    hint.textContent = command.argumentHint;
  }
  const said = row.appendChild(document.createElement('span'));
  said.className = 'cm-commandSays';
  said.textContent = command.description;
  if (command.kind === 'skill') {
    const where = row.appendChild(document.createElement('span'));
    where.className = 'cm-commandWhere';
    where.textContent = command.execution === 'shared' ? 'Atelier' : 'skill';
  }
  return row;
}

/**
 * What a menu line is named for a machine: the `/` menu is the command menu it
 * always was, so everything that looked for it by name still finds it.
 */
function nameTheMenu(line: HTMLElement, name: string): void {
  queueMicrotask(() => line.closest('.cm-tooltip-autocomplete')?.setAttribute('data-testid', name));
}

/**
 * The menu opens for a slash however the slash got into the box.
 *
 * CodeMirror opens a menu for a keystroke in its own writing surface. The box
 * has a second door, the form control a machine types into
 * (`composer-editor.tsx`), and a draft put back after a reload comes through
 * neither. A slash word arriving by any of them opens the `/` menu, and so does
 * the chat's command list changing under an open one — the provider's own
 * commands arrive a beat after the box does.
 */
function slashOpens(feed: CommandFeed) {
  return ViewPlugin.fromClass(
    class {
      private readonly stop: () => void;
      /** The words a person closed the menu on; commands arriving later leave them alone. */
      private dismissed: string | null = null;

      constructor(private readonly view: EditorView) {
        // Commands can arrive after the slash does: a chat that is not awake
        // hears what its provider offers only once it wakes. The menu that had
        // nothing to show then opens with them.
        this.stop = feed.subscribe(() => {
          const typed = view.state.doc.toString();
          if (!SLASH_WORD.test(typed)) return;
          if (completionStatus(view.state) === null && typed === this.dismissed) return;
          startCompletion(view);
        });
        // A box built around a slash already written, as a draft it was handed.
        if (SLASH_WORD.test(view.state.doc.toString())) queueMicrotask(() => startCompletion(view));
      }

      update(update: ViewUpdate) {
        if (update.docChanged) {
          this.dismissed = null;
        } else if (completionStatus(update.startState) === 'active' && completionStatus(update.state) === null) {
          // Only a menu he saw is one he closed; one that found nothing to show shut itself.
          this.dismissed = update.state.doc.toString();
        }
        if (!update.docChanged) return;
        // Asked again even while it is open: a line the app put there is not
        // typing, and CodeMirror only asks again for typing.
        if (!SLASH_WORD.test(update.state.doc.toString())) return;
        queueMicrotask(() => startCompletion(this.view));
      }

      destroy() {
        this.stop();
      }
    },
  );
}

/**
 * A tap on a line picks it.
 *
 * CodeMirror picks on `mousedown`, and a phone only produces mouse events if it
 * decides to emulate them — which it declines to on a list it reads the tap as
 * the start of a scroll on, so on a phone picking did nothing at all
 * (bw-ad3r.9). Pointer events arrive for every kind of pointer, so a touch
 * or a pen picks on its own `pointerdown`.
 */
const tapPicks = ViewPlugin.fromClass(
  class {
    private readonly picked = (event: PointerEvent) => {
      // A mouse is served by CodeMirror's own `mousedown`, which also needs no
      // pause after the menu opens.
      if (event.pointerType === 'mouse') return;
      const line = (event.target as Element | null)?.closest?.('.cm-tooltip-autocomplete li[id]');
      const at = line ? /-(\d+)$/.exec(line.id) : null;
      if (!at) return;
      event.preventDefault();
      this.view.dispatch({ effects: setSelectedCompletion(Number(at[1])) });
      acceptCompletion(this.view);
    };

    constructor(private readonly view: EditorView) {
      view.dom.addEventListener('pointerdown', this.picked);
    }

    destroy() {
      this.view.dom.removeEventListener('pointerdown', this.picked);
    }
  },
);

/** The menu's own look: the app's colours, and room for an icon per line. */
const menuTheme = EditorView.theme({
  '.cm-tooltip.cm-tooltip-autocomplete': {
    border: '1px solid hsl(var(--border))',
    borderRadius: '0.5rem',
    backgroundColor: 'hsl(var(--popover))',
    color: 'hsl(var(--popover-foreground))',
    boxShadow: '0 4px 12px rgb(0 0 0 / 0.12)',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'inherit',
    fontSize: '13px',
    maxHeight: '16rem',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    display: 'flex',
    alignItems: 'center',
    gap: '0.375rem',
    padding: '0.25rem 0.5rem',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'hsl(var(--accent))',
    color: 'hsl(var(--accent-foreground))',
  },
  '.cm-fileIcon': { height: '16px', width: '16px', flexShrink: '0' },
  '.cm-referenceBadge': { flexShrink: '1', minWidth: '0', margin: '0' },
  // A command's line is drawn whole by `drawCommand`.
  '.cm-completion-command .cm-completionLabel, .cm-completion-pending .cm-completionLabel': { display: 'none' },
  '.cm-commandRow': { display: 'flex', alignItems: 'baseline', gap: '0.5rem', minWidth: '0', width: '100%' },
  '.cm-commandName': { flexShrink: '0', fontFamily: 'var(--font-mono, ui-monospace, monospace)' },
  '.cm-commandHint': { flexShrink: '0', fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: '12px', opacity: '0.6' },
  '.cm-commandSays': { minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px', opacity: '0.6' },
  '.cm-commandWhere': {
    marginLeft: 'auto',
    flexShrink: '0',
    borderRadius: '9999px',
    padding: '0 0.4rem',
    fontSize: '11px',
    backgroundColor: 'hsl(var(--secondary))',
    color: 'hsl(var(--secondary-foreground))',
  },
  '.cm-commandPending': { fontSize: '12px', opacity: '0.6' },
  // A chat's and a skill's badge is its name, so the line has no words of its own.
  '.cm-completion-chat .cm-completionLabel, .cm-completion-skill .cm-completionLabel': { display: 'none' },
  'completion-section': {
    display: 'block',
    padding: '0.375rem 0.5rem 0.125rem',
    fontSize: '11px',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    opacity: '0.6',
    borderBottom: 'none',
  },
  '.cm-completionLabel': { flexShrink: '0' },
  // The folder, after the name and behind it: enough to tell two files of the
  // same name apart, never enough to read before the name itself.
  '.cm-completionDetail': {
    fontStyle: 'normal',
    marginLeft: 'auto',
    paddingLeft: '0.75rem',
    opacity: '0.55',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    direction: 'rtl',
    textAlign: 'right',
  },
});

/**
 * The room the menu is allowed to draw in.
 *
 * CodeMirror puts a tooltip wherever there is space between 0 and
 * `documentElement.clientHeight`, and on a phone that is a lie: the keyboard is
 * drawn over the bottom third of the window without changing a single length
 * the layout knows about. The survey found the menu at y=670..752 of an 844px
 * window with only y<508 left to look at — the whole list under the keyboard,
 * at the one moment it is wanted (bw-e3dw.1).
 *
 * So the space is the visual viewport, which is the part of the page the
 * reader can see and the only thing that moves when a keyboard comes up. The
 * numbers are the ones the tooltip is positioned in, which is the window's own
 * frame, so the visual viewport's offset within it is part of the answer. On a
 * desktop the two viewports are the same rectangle and this changes nothing.
 */
function roomToDrawIn(view: EditorView) {
  const page = view.dom.ownerDocument.documentElement;
  const seen = view.dom.ownerDocument.defaultView?.visualViewport;
  if (!seen) return { top: 0, left: 0, bottom: page.clientHeight, right: page.clientWidth };
  return {
    top: seen.offsetTop,
    left: seen.offsetLeft,
    bottom: seen.offsetTop + seen.height,
    right: seen.offsetLeft + seen.width,
  };
}

/**
 * Measure again when the keyboard moves.
 *
 * A keyboard opening is not a layout change and fires no `resize` a tooltip
 * would hear, so a menu already open when it appears would keep the place it
 * was given under the old rectangle.
 */
const followTheKeyboard = ViewPlugin.fromClass(
  class {
    private readonly again: () => void;
    private readonly seen = typeof window === 'undefined' ? null : window.visualViewport;

    constructor(view: EditorView) {
      this.again = () => view.requestMeasure();
      this.seen?.addEventListener('resize', this.again);
      this.seen?.addEventListener('scroll', this.again);
    }

    destroy() {
      this.seen?.removeEventListener('resize', this.again);
      this.seen?.removeEventListener('scroll', this.again);
    }
  },
);

/**
 * The `@` menu, ready to be handed to `ComposerEditor` as `extra`.
 *
 * `placeOf` is asked where the chat is at every keystroke rather than once —
 * see the note at the top of this file.
 *
 * The keymap is `Prec.highest` because Enter, Escape and the arrow keys mean
 * something else in the composer: Enter sends, Escape recalls. While a menu is
 * open those keys are the menu's, and CodeMirror's own handlers stand down
 * when it is shut, so the chat gets them back the moment it closes. For this to
 * hold, `composer-editor.tsx` places `extra` ahead of the chat's own keymap.
 */
export function mentionCompletions(
  placeOf: () => MentionPlace,
  commands: CommandFeed = commandFeed(),
): Extension {
  setReferenceAsker(askAboutNames(placeOf));
  return [
    autocompletion({
      override: [commandsOffering(commands), offering(placeOf)],
      // The provider's own list can run past a hundred on its own (bw-zldt.1).
      maxRenderedOptions: 400,
      optionClass: (completion: Completion) => 'cm-completion-' + (completion.type ?? 'file'),
      // Ours are drawn by `addToOptions` below; the built-in ones are a font of
      // little letters that say nothing a file icon does not say better.
      icons: false,
      defaultKeymap: false,
      // Every keystroke asks the server again, and the server answers from a
      // listing it already holds. Filtering the last answer locally instead
      // would use CodeMirror's ranking, which is the one thing this must not do.
      activateOnTyping: true,
      // The box has two doors, the line he sees and the form control a machine
      // types into (composer-editor.tsx), and focus moving from one to the other
      // is not leaving. The line closes the menu itself when he leaves the box;
      // the form control, which only a machine ever focuses, closes nothing.
      closeOnBlur: false,
      addToOptions: [
        {
          position: 10,
          render: (completion: Completion) => {
            const command = drawnCommands.get(completion);
            if (command) {
              const drawn = drawCommand(command);
              nameTheMenu(drawn, 'command-menu');
              return drawn;
            }
            const badge = drawnBadges.get(completion);
            if (badge) {
              const drawn = referenceBadgeElement(badge);
              drawn.classList.add('cm-referenceBadge');
              drawn.setAttribute('data-testid', 'mention-option-badge');
              return drawn;
            }
            const path = completion.label.slice(1);
            return picture({ path, kind: completion.type === 'folder' ? 'dir' : 'file' });
          },
        },
      ],
    }),
    Prec.highest(keymap.of(completionKeymap)),
    tooltips({ tooltipSpace: roomToDrawIn }),
    followTheKeyboard,
    slashOpens(commands),
    tapPicks,
    menuTheme,
  ];
}
