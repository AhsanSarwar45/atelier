'use client';

/**
 * The line he writes in, as one CodeMirror 6 view.
 *
 * Hand-rolled for the same reason the file viewer is (`code-editor.tsx`): the
 * wrapper packages tear the view down and stand a new one up whenever a prop
 * moves, and this box is handed a new `onKeyDown` on every keystroke — the
 * command menu it consults is recomputed as he types. A view rebuilt that often
 * has no undo history, no selection and no cursor.
 *
 * ## Why it stopped being a textarea
 *
 * A textarea draws characters and nothing else, and a file reference is not
 * characters: `@src/paths.ts:12-40` is one thing the reader points at, and it
 * has to LOOK like the one thing the transcript already draws for it
 * (`path-chip.tsx`). So every reference in the text is replaced by a badge
 * widget, while the document underneath stays exactly the characters he typed —
 * which is what `prompt.send` carries, byte for byte. The badge is a drawing of
 * the text, never a substitute for it.
 *
 * ## The textarea that stayed
 *
 * CodeMirror's writing surface is a `contenteditable`, and a contenteditable has
 * no `value`. Everything outside this component that reads or drives the
 * composer — the browser's own automation, and every end-to-end test in this
 * repository — asks a form control for its value. So a real textarea stays,
 * carrying `data-testid="composer"`, holding exactly the document, and wearing
 * exactly the same keystroke rules. It is out of sight and out of the tab
 * order, so a reader never meets it and a machine always does, and both
 * surfaces call the same two callbacks, so there is one set of rules and two
 * doors into it.
 *
 * ## What is deliberately not here
 *
 * The `@` completion menu is bw-gr8y.7's, and it arrives through `extra`:
 * `composer-files.ts` builds a CodeMirror completion source and this view is
 * handed it once, at build, and never reconfigures it. `extra` sits AHEAD of
 * the chat's own keymap, because a menu that is open owns Enter and Escape —
 * see the comment beside it below.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

import { acceptCompletion, closeCompletion, completionStatus, moveCompletionSelection } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { Prec, StateEffect, type EditorState, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  drawSelection,
  dropCursor,
  keymap,
  placeholder as placeholderText,
  runScopeHandlers,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';

import { FILE_BADGE_CLASS, FILE_KINDS, fileKind, type FileKind } from '@/components/file-kinds';
import { badgeElement } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { ExternalChange } from '@/workbench/code-editor';
import type { DraftPicture } from '@/workbench/composer-attachments';
import { opens as opensIt } from '@/workbench/attachment-look';
import { drawnMarks } from '@/workbench/drawn-marks';
import { referenceBadgeElement, type Reference } from '@/components/reference-badge';
import type { DescribeReference } from '@/workbench/reference-names';
import { findAtelierReferences, findReferences, referenceForAddress, referenceLabel } from '@/workbench/references';

/** What the chat holds this box by: the one thing it ever asks of it. */
export interface ComposerHandle {
  focus(): void;
  cursor(): number;
}

/**
 * A key arriving at the form control while a menu is open is the menu's, the
 * same as it is in the drawn line: the arrows move through it, Enter picks,
 * Tab does what the open menu makes it, Escape puts it away. One rule for both
 * doors into the box.
 */
function menuKey(view: EditorView | null, event: KeyboardEvent): boolean {
  if (!view || completionStatus(view.state) !== 'active') return false;
  const { key, shiftKey: shift } = event;
  if (key === 'ArrowDown') return moveCompletionSelection(true)(view);
  if (key === 'ArrowUp') return moveCompletionSelection(false)(view);
  // Tab is whatever the open menu makes it, exactly as in the drawn line: in
  // the `@` menu it moves between the kinds, in the `/` menu it picks.
  if (key === 'Tab') return runScopeHandlers(view, event, 'editor');
  if (key === 'Enter' && !shift) return acceptCompletion(view);
  if (key === 'Escape') return closeCompletion(view);
  return false;
}

/**
 * Whether focus going to `to` leaves the box: not to the line he sees, not to
 * the form control beside it, not into the menu over it.
 */
function leavesTheBox(to: EventTarget | null, view: EditorView): boolean {
  if (!(to instanceof Element)) return true;
  // The editor sits in the box's host, beside the form control (below).
  const box = view.dom.parentElement?.parentElement ?? view.dom;
  if (box.contains(to)) return false;
  return to.closest('.cm-tooltip') === null;
}

const RefreshPictures = StateEffect.define<void>();

/** Where an icon of a given kind is fetched from, already drawn. */
type IconSource = (kind: FileKind) => Node | null;

/**
 * The badge's own classes, taken from the chip the transcript draws rather than
 * written again (`path-chip.tsx`): the composer and the transcript are showing
 * the reader the same reference, and a second copy of the recipe is a second
 * chance for them to drift apart.
 */
const badgeClass = (kind: FileKind) =>
  cn(FILE_BADGE_CLASS, FILE_KINDS[kind].color);

/**
 * One badge, for both things the writing box draws as one.
 *
 * A path the reader typed and a picture they attached are the same object to
 * them — a file, named in the line they are writing — and they were two
 * different chips: the path got the file kind's icon and colour, the picture
 * got a bare primary pill with its name in it and no icon at all. Worse, the
 * picture's was built by hand instead of from the component, so it missed the
 * `data-slot` that exempts a chip from the coarse-pointer floor and stood
 * comically tall on a phone while staying 20px on a desktop (bw-e9p5.1).
 *
 * The only thing that still differs is whether it answers a press: a picture
 * opens full size, a path is a drawing of text still being edited and must let
 * the click through to place a caret. That is the `onOpen` below and nothing
 * else — the drawing is one drawing.
 */
class FileBadge extends WidgetType {
  constructor(
    readonly label: string,
    readonly kind: FileKind,
    private readonly icon: IconSource,
    /** The picture this stands for, when it stands for one. */
    readonly picture?: DraftPicture,
    private readonly onOpen?: (picture: DraftPicture) => void,
  ) {
    super();
  }

  /** Two badges are the same badge when they say the same thing. */
  eq(other: FileBadge): boolean {
    return other.label === this.label && other.kind === this.kind && other.picture?.id === this.picture?.id;
  }

  toDOM(): HTMLElement {
    const opens = Boolean(this.picture && this.onOpen);
    const badge = badgeElement(opens ? 'button' : 'span', {
      variant: 'primary',
      appearance: 'outline',
      size: 'sm',
      shape: 'circle',
      wrap: true,
      className: cn(badgeClass(this.kind), opens ? 'cursor-pointer select-none' : 'cursor-default select-none'),
    });
    if (this.picture) {
      badge.setAttribute('data-testid', 'composer-image-badge');
      badge.setAttribute('data-image-id', this.picture.id);
    } else {
      badge.setAttribute('data-testid', 'composer-reference');
      badge.setAttribute('data-reference', this.label);
    }
    badge.setAttribute('data-file-kind', this.kind);
    const icon = this.icon(this.kind);
    if (icon) badge.appendChild(icon);
    const words = document.createElement('span');
    words.textContent = this.label;
    badge.appendChild(words);
    if (opens) badge.onclick = () => this.onOpen!(this.picture!);
    return badge;
  }

  /**
   * A picture's badge is a control and takes its own press; a path's is a
   * drawing of text the reader is still editing, so the click goes through it
   * to place a caret.
   */
  ignoreEvent(): boolean {
    return !(this.picture && this.onOpen);
  }
}

/**
 * A card, a chat or a skill named in the line, as the badge a sent message
 * draws for it (`reference-badge.tsx`, bw-mi3s.1). A drawing of text still
 * being edited, like a path's: the click goes through it to place a caret.
 */
class AtelierBadge extends WidgetType {
  private readonly key: string;

  constructor(readonly reference: Reference) {
    super();
    this.key = JSON.stringify(reference);
  }

  eq(other: AtelierBadge): boolean {
    return other.key === this.key;
  }

  toDOM(): HTMLElement {
    return referenceBadgeElement(this.reference);
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Where a reference to one of Atelier's things is drawn as a badge: everywhere
 * but at the very end of the line with the caret after it, which is where it is
 * still being typed. `@bead:bw-z` on its way to `@bead:bw-zldt.2` is words until
 * the writer moves on; anywhere else it is one atomic badge, and Backspace takes
 * all of it, the same as a file's.
 */
function stillTyped(state: EditorState, ref: { end: number }): boolean {
  const { empty, head } = state.selection.main;
  return empty && head === ref.end && ref.end === state.doc.length;
}

function atelierBadges(state: EditorState, describe: DescribeReference | undefined) {
  if (!describe) return [];
  const text = state.doc.toString();
  return findAtelierReferences(text)
    .filter((ref) => !stillTyped(state, ref))
    .map((ref) => Decoration.replace({ widget: new AtelierBadge(describe(ref.kind, ref.id)) }).range(ref.start, ref.end));
}

/**
 * Every reference in the document, as a badge over exactly its characters. A
 * file's is held back while the `@` menu is open on it, since then it is still
 * being typed: `@z` on its way to a name was drawn as a badge for a file called
 * `z`. One pasted whole opens no menu and is drawn at once.
 */
function badges(state: EditorState, icon: IconSource, picture: (id: string) => DraftPicture | undefined, onOpen: (picture: DraftPicture) => void, describe: () => DescribeReference | undefined): DecorationSet {
  const text = state.doc.toString();
  const menuOpen = completionStatus(state) !== null;
  const references = findReferences(text).filter((ref) => !(menuOpen && stillTyped(state, ref))).map((ref) =>
      Decoration.replace({ widget: new FileBadge(referenceLabel(ref), fileKind(ref.path), icon) }).range(
        ref.start,
        ref.end,
      ),
    );
  const pictures = Array.from(text.matchAll(/\[\[atelier-image:([a-zA-Z0-9_-]+)\]\]/g)).flatMap((match) => {
    const found = picture(match[1]!);
    if (!found || match.index === undefined) return [];
    const kind = fileKind(found.alt);
    // A press opens what there is something to open: a picture, a video, a
    // recording, a PDF, a file of words. An archive has nothing a browser can
    // show, so its badge lets the click through to place a caret instead of
    // opening an empty box (`attachment-look.ts`).
    const press = opensIt(found) ? onOpen : undefined;
    return [Decoration.replace({ widget: new FileBadge(found.alt, kind, icon, found, press) }).range(match.index, match.index + match[0].length)];
  });
  return Decoration.set([...references, ...pictures, ...atelierBadges(state, describe())], true);
}

/**
 * The badges, kept current, and treated as single characters.
 *
 * Atomic is the second half of the promise: a badge stands for a whole
 * reference, so the cursor may not land in the middle of one and Backspace at
 * the end of one takes all of it. Without that, deleting a badge would eat one
 * character of a path that is no longer on screen to be read.
 */
function referenceBadges(icon: IconSource, picture: (id: string) => DraftPicture | undefined, onOpen: (picture: DraftPicture) => void, describe: () => DescribeReference | undefined): Extension {
  const drawn = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = badges(view.state, icon, picture, onOpen, describe);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || completionStatus(update.startState) !== completionStatus(update.state) || update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(RefreshPictures)))) {
          this.decorations = badges(update.state, icon, picture, onOpen, describe);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
  return [drawn, EditorView.atomicRanges.of((view) => view.plugin(drawn)?.decorations ?? Decoration.none)];
}

/**
 * The box's own look. Everything it wears is the frame's — no border, no
 * background and no shadow of its own — and it grows with what is written until
 * it would start taking the conversation's room.
 */
const composerTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'inherit',
    // 16px, and not a pixel under. Safari on an iPhone zooms the whole page in
    // when a control smaller than this takes focus, and never zooms back out —
    // so tapping the writing box threw the layout sideways and read as the box
    // being broken (bw-ad3r.8).
    fontSize: '16px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: '1.5rem',
    overflowY: 'auto',
    maxHeight: '14rem',
  },
  '.cm-content': {
    padding: '0',
  },
  '.cm-line': { padding: '0' },
  '.cm-placeholder': { color: 'hsl(var(--muted-foreground))' },
});

export interface ComposerEditorProps {
  /** What is written. Changing it from outside replaces the document. */
  value: string;
  /** Called for every edit he makes; never for a line put back by the app. */
  onChange: (text: string) => void;
  /**
   * Every keystroke, before anything else sees it. Returning true means the
   * chat took it — Enter that sent, Escape that recalled — and it goes no
   * further.
   */
  /** Every modifier the chat's reading needs: Enter holds, Cmd/Ctrl+Enter pushes. */
  onKey: (event: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => boolean;
  /** Files arriving by paste or by drop; both are the chat's to absorb. */
  onFiles: (files: File[], at: number) => void;
  pictures?: DraftPicture[];
  onOpenPicture?: (picture: DraftPicture) => void;
  placeholder?: string;
  /** bw-gr8y.7's seam: read once, when the view is built. */
  extra?: Extension;
  /**
   * What a card, a chat or a skill named in the line is drawn as. A new one
   * redraws the badges — a card's status moved, a chat's name arrived.
   */
  describe?: DescribeReference;
  className?: string;
}

export const ComposerEditor = forwardRef<ComposerHandle, ComposerEditorProps>(function ComposerEditor(
  { value, onChange, onKey, onFiles, pictures = [], onOpenPicture = () => {}, placeholder, extra, describe, className },
  ref,
) {
  const host = useRef<HTMLDivElement | null>(null);
  const icons = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);

  // Read through refs so that a parent which rebuilds its handlers every
  // keystroke — this one does, because the `/` menu is recomputed as he types —
  // does not rebuild the editor with them.
  const changed = useRef(onChange);
  const keyed = useRef(onKey);
  const filed = useRef(onFiles);
  const pictured = useRef(pictures);
  const openPicture = useRef(onOpenPicture);
  changed.current = onChange;
  keyed.current = onKey;
  filed.current = onFiles;
  pictured.current = pictures;
  openPicture.current = onOpenPicture;
  const described = useRef(describe);
  described.current = describe;

  // Built once; the props at that moment are the starting state.
  const opening = useRef({ value, placeholder, extra });
  opening.current = view.current ? opening.current : { value, placeholder, extra };

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;

    const start = opening.current;
    const editor = new EditorView({
      doc: start.value,
      // At the end of what is already there: a draft he left in this chat is
      // one he is going on with, not one he is about to type in front of.
      selection: { anchor: start.value.length },
      parent,
      extensions: [
        history(),
        drawSelection(),
        dropCursor(),
        // Both of the above draw a caret of their own instead of the browser's,
        // and drawSelection() draws the band under selected text too; none of
        // them knows what colour this app's ink is. drawn-marks.ts is where
        // that is answered, once, for this box and for the Files tab's editor
        // together (bw-axtp.1, bw-axtp.3).
        drawnMarks,
        EditorView.lineWrapping,
        placeholderText(start.placeholder ?? ''),
        composerTheme,
        // The kind's icon is cloned out of the hidden row below rather than
        // built here: the icons are React components, and a widget is plain
        // DOM. One drawing of each kind, cloned as often as it is needed.
        referenceBadges(
          (kind) => icons.current?.querySelector(`[data-icon-kind="${kind}"]`)?.cloneNode(true) ?? null,
          (id) => pictured.current.find((picture) => picture.id === id),
          (picture) => openPicture.current(picture),
          () => described.current,
        ),
        // Ahead of the chat's own answer to a key, because bw-gr8y.7's `@` menu
        // lives in here: while that menu is open, Enter picks a file and Escape
        // shuts the menu, and neither may reach the chat's Enter-sends and
        // Escape-recalls. Every handler it installs stands down when no menu is
        // open, so the ordinary keystroke still falls through to the line below.
        start.extra ?? [],
        // Ahead of everything else, including Enter and Escape: the chat's
        // answer to a key is the first answer, not a fallback after
        // CodeMirror's own.
        Prec.highest(keymap.of([{ any: (_view, event) => keyed.current(event) }])),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.domEventHandlers({
          blur: (event, editorView) => {
            if (!leavesTheBox(event.relatedTarget, editorView)) return false;
            closeCompletion(editorView);
            return false;
          },
          // Pictures are taken and the event is left alone, so pasted TEXT still
          // lands in the box the ordinary way.
          paste: (event, editorView) => {
            // A card or a chat of this app, copied from the address bar, goes in
            // as the reference it names (bw-mi3s.5).
            const named = referenceForAddress(event.clipboardData?.getData('text/plain') ?? '', window.location.origin);
            if (named && !event.clipboardData?.files.length) {
              const { from, to } = editorView.state.selection.main;
              const insert = named + ' ';
              editorView.dispatch({
                changes: { from, to, insert },
                selection: { anchor: from + insert.length },
                userEvent: 'input.paste',
              });
              return true;
            }
            filed.current(Array.from(event.clipboardData?.files ?? []), editorView.state.selection.main.head);
            return false;
          },
          drop: (event, editorView) => {
            event.preventDefault();
            filed.current(Array.from(event.dataTransfer?.files ?? []), editorView.posAtCoords({ x: event.clientX, y: event.clientY }) ?? editorView.state.selection.main.head);
            return true;
          },
        }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          if (update.transactions.some((t) => t.annotation(ExternalChange))) return;
          changed.current(update.state.doc.toString());
        }),
      ],
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  // A line put back by the app — a refused send, a recalled prompt, a command
  // picked from the menu, the box emptied on send — says who did it, so it does
  // not come back out as something he typed.
  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: value },
      selection: { anchor: value.length },
      annotations: ExternalChange.of(true),
    });
  }, [value]);

  useEffect(() => { view.current?.dispatch({ effects: RefreshPictures.of() }); }, [pictures, describe]);

  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    cursor: () => view.current?.state.selection.main.head ?? value.length,
  }), [value]);

  return (
    <div className={cn('relative', className)}>
      <div ref={host} />
      {/* One drawing of each file kind, off the page, so a badge can clone the
          icon its kind wears without this file knowing how to draw one. */}
      <div ref={icons} aria-hidden="true" className="hidden">
        {(Object.keys(FILE_KINDS) as FileKind[]).map((kind) => {
          const Icon = FILE_KINDS[kind].icon;
          return <Icon key={kind} data-icon-kind={kind} className="mr-0.5 h-3 w-3 shrink-0" />;
        })}
      </div>
      {/* The document as a form control: what has a `value`, and what a machine
          types into. Out of sight rather than `display: none`, because a
          control that is not laid out is one a machine cannot type into
          either — and hidden from assistive technology too, since the drawn
          line above is the one composer a reader is offered. */}
      <textarea
        data-testid="composer"
        aria-hidden="true"
        tabIndex={-1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (menuKey(view.current, e.nativeEvent) || onKey(e)) e.preventDefault();
        }}
        onPaste={(e) => {
          const named = referenceForAddress(e.clipboardData.getData('text/plain'), window.location.origin);
          if (named && !e.clipboardData.files.length) {
            e.preventDefault();
            const box = e.currentTarget;
            const insert = named + ' ';
            onChange(value.slice(0, box.selectionStart) + insert + value.slice(box.selectionEnd));
            return;
          }
          onFiles(Array.from(e.clipboardData.files), value.length);
        }}
        onDrop={(e) => {
          e.preventDefault();
          onFiles(Array.from(e.dataTransfer.files), value.length);
        }}
        className="sr-only"
      />
    </div>
  );
});
