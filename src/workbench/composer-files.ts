/**
 * Typing `@` in the composer offers the files of the checkout (bw-gr8y.7).
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
import { EditorView, keymap } from '@codemirror/view';

import { iconForFile, iconForFolder } from '@/components/file-icon';
import { ICON_FALLBACK, iconUrl } from '@/components/file-icons';
import { fs, type FsFoundPath } from '@/lib/api';
import { canBeginReference, formatReference } from '@/workbench/references';

/** How many the menu ever shows. Past this nobody is reading, he is typing. */
const MOST_OFFERED = 20;

/**
 * The characters that still belong to the reference being typed.
 *
 * Whitespace ends it, and so does a second `@`, so `me@example.com` never opens
 * a menu behind the cursor. A quote ends it too: `@"a name with spaces"` is a
 * shape the grammar allows but not one anybody types a search into.
 */
const TYPING = /@[^\s@"'`]*$/;

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

/** One found path as a line of the menu. */
function offer(found: FsFoundPath): Completion {
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

/**
 * What the menu offers for what has been typed after the `@`.
 *
 * Answers nothing at all unless the cursor really is inside a reference — an
 * `@` that begins one, by the same rule `references.ts` reads text with, so an
 * email address is left alone.
 */
function offering(rootOf: () => string): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const token = context.matchBefore(TYPING);
    if (!token) return null;
    const before = token.from === 0 ? '' : context.state.sliceDoc(token.from - 1, token.from);
    if (!canBeginReference(before)) return null;

    const root = rootOf();
    if (!root) return null;

    let found;
    try {
      found = await fs.find(root, token.text.slice(1), MOST_OFFERED);
    } catch {
      // A checkout that has gone away, or a server that is restarting: the
      // right answer is no menu, not a red line under what he is writing.
      return null;
    }
    if (context.aborted) return null;

    return {
      from: token.from,
      options: found.entries.map(offer),
      // The server's ranking is the ranking. See the note at the top.
      filter: false,
    };
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
 * The `@` menu, ready to be handed to `ComposerEditor` as `extra`.
 *
 * `rootOf` is asked for the folder to search at every keystroke rather than
 * once — see the note at the top of this file.
 *
 * The keymap is `Prec.highest` because Enter, Escape and the arrow keys mean
 * something else in the composer: Enter sends, Escape recalls. While a menu is
 * open those keys are the menu's, and CodeMirror's own handlers stand down
 * when it is shut, so the chat gets them back the moment it closes. For this to
 * hold, `composer-editor.tsx` places `extra` ahead of the chat's own keymap.
 */
export function fileCompletions(rootOf: () => string): Extension {
  return [
    autocompletion({
      override: [offering(rootOf)],
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
            const path = completion.label.slice(1);
            return picture({ path, kind: completion.type === 'folder' ? 'dir' : 'file' });
          },
        },
      ],
    }),
    Prec.highest(keymap.of(completionKeymap)),
    menuTheme,
  ];
}
