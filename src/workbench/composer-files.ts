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
  autocompletion,
  completionKeymap,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { Prec, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap, tooltips } from '@codemirror/view';

import { iconForFile, iconForFolder } from '@/components/file-icon';
import { ICON_FALLBACK, iconUrl } from '@/components/file-icons';
import { referenceBadgeElement, type Reference } from '@/components/reference-badge';
import { mention, type FsFoundPath, type MentionOffer, type MentionPlace } from '@/lib/api';
import type { BeadStatus } from '@/types';
import type { Brand } from '@/workbench/protocol';
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
export function mentionCompletions(placeOf: () => MentionPlace): Extension {
  setReferenceAsker(askAboutNames(placeOf));
  return [
    autocompletion({
      override: [offering(placeOf)],
      optionClass: (completion: Completion) => 'cm-completion-' + (completion.type ?? 'file'),
      // Ours are drawn by `addToOptions` below; the built-in ones are a font of
      // little letters that say nothing a file icon does not say better.
      icons: false,
      defaultKeymap: false,
      // Every keystroke asks the server again, and the server answers from a
      // listing it already holds. Filtering the last answer locally instead
      // would use CodeMirror's ranking, which is the one thing this must not do.
      activateOnTyping: true,
      closeOnBlur: true,
      addToOptions: [
        {
          position: 10,
          render: (completion: Completion) => {
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
    menuTheme,
  ];
}
