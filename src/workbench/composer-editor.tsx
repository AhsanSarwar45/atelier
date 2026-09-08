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

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { Prec, type EditorState, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  drawSelection,
  dropCursor,
  keymap,
  placeholder as placeholderText,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';

import { FILE_BADGE_CLASS, FILE_KINDS, fileKind, type FileKind } from '@/components/file-kinds';
import { badgeVariants } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { ExternalChange } from '@/workbench/code-editor';
import { findReferences, referenceLabel } from '@/workbench/references';

/** What the chat holds this box by: the one thing it ever asks of it. */
export interface ComposerHandle {
  focus(): void;
}

/** Where an icon of a given kind is fetched from, already drawn. */
type IconSource = (kind: FileKind) => Node | null;

/**
 * The badge's own classes, taken from the chip the transcript draws rather than
 * written again (`path-chip.tsx`): the composer and the transcript are showing
 * the reader the same reference, and a second copy of the recipe is a second
 * chance for them to drift apart.
 */
const badgeClass = (kind: FileKind) =>
  cn(
    badgeVariants({ variant: 'primary', appearance: 'outline', size: 'sm', shape: 'circle' }),
    FILE_BADGE_CLASS,
    FILE_KINDS[kind].color,
    'cursor-default select-none',
  );

/** One reference, drawn where its characters are. */
class ReferenceBadge extends WidgetType {
  constructor(
    readonly label: string,
    readonly kind: FileKind,
    private readonly icon: IconSource,
  ) {
    super();
  }

  /** Two badges are the same badge when they say the same thing. */
  eq(other: ReferenceBadge): boolean {
    return other.label === this.label && other.kind === this.kind;
  }

  toDOM(): HTMLElement {
    const badge = document.createElement('span');
    badge.className = badgeClass(this.kind);
    badge.setAttribute('data-testid', 'composer-reference');
    badge.setAttribute('data-reference', this.label);
    badge.setAttribute('data-file-kind', this.kind);
    const icon = this.icon(this.kind);
    if (icon) badge.appendChild(icon);
    const words = document.createElement('span');
    words.textContent = this.label;
    badge.appendChild(words);
    return badge;
  }

  /** Nothing to click: the badge is a drawing of text he is still editing. */
  ignoreEvent(): boolean {
    return true;
  }
}

/** Every reference in the document, as a badge over exactly its characters. */
function badges(state: EditorState, icon: IconSource): DecorationSet {
  const text = state.doc.toString();
  return Decoration.set(
    findReferences(text).map((ref) =>
      Decoration.replace({ widget: new ReferenceBadge(referenceLabel(ref), fileKind(ref.path), icon) }).range(
        ref.start,
        ref.end,
      ),
    ),
  );
}

/**
 * The badges, kept current, and treated as single characters.
 *
 * Atomic is the second half of the promise: a badge stands for a whole
 * reference, so the cursor may not land in the middle of one and Backspace at
 * the end of one takes all of it. Without that, deleting a badge would eat one
 * character of a path that is no longer on screen to be read.
 */
function referenceBadges(icon: IconSource): Extension {
  const drawn = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = badges(view.state, icon);
      }

      update(update: ViewUpdate) {
        if (update.docChanged) this.decorations = badges(update.state, icon);
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
    fontSize: '15px',
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
    caretColor: 'hsl(var(--text-primary))',
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
  onKey: (event: { key: string; shiftKey: boolean }) => boolean;
  /** Files arriving by paste or by drop; both are the chat's to absorb. */
  onFiles: (files: File[]) => void;
  placeholder?: string;
  /** bw-gr8y.7's seam: read once, when the view is built. */
  extra?: Extension;
  className?: string;
}

export const ComposerEditor = forwardRef<ComposerHandle, ComposerEditorProps>(function ComposerEditor(
  { value, onChange, onKey, onFiles, placeholder, extra, className },
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
  changed.current = onChange;
  keyed.current = onKey;
  filed.current = onFiles;

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
        EditorView.lineWrapping,
        placeholderText(start.placeholder ?? ''),
        composerTheme,
        // The kind's icon is cloned out of the hidden row below rather than
        // built here: the icons are React components, and a widget is plain
        // DOM. One drawing of each kind, cloned as often as it is needed.
        referenceBadges((kind) => icons.current?.querySelector(`[data-icon-kind="${kind}"]`)?.cloneNode(true) ?? null),
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
          // Pictures are taken and the event is left alone, so pasted TEXT still
          // lands in the box the ordinary way.
          paste: (event) => {
            filed.current(Array.from(event.clipboardData?.files ?? []));
            return false;
          },
          drop: (event) => {
            event.preventDefault();
            filed.current(Array.from(event.dataTransfer?.files ?? []));
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

  useImperativeHandle(ref, () => ({ focus: () => view.current?.focus() }), []);

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
          if (onKey(e)) e.preventDefault();
        }}
        onPaste={(e) => onFiles(Array.from(e.clipboardData.files))}
        onDrop={(e) => {
          e.preventDefault();
          onFiles(Array.from(e.dataTransfer.files));
        }}
        className="sr-only"
      />
    </div>
  );
});
