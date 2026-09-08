'use client';

/**
 * One CodeMirror 6 view, held by React and reconfigured rather than rebuilt.
 *
 * Hand-rolled on purpose. The wrapper packages all tear the view down and put a
 * new one up whenever a prop moves, which loses the scroll position, the fold
 * state, the undo history and the selection — and this viewer's whole job is to
 * survive those moves: a file goes read-only to editable on a keystroke, a
 * grammar lands a tick after the text does, and a skin changes under both.
 *
 * So the view is created exactly once, in an effect (never at render: the app
 * is a static export, and CodeMirror measures the DOM the moment it is built),
 * and everything that can move afterwards sits behind a Compartment.
 */

import { useEffect, useRef } from 'react';

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { LanguageDescription, bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Annotation, Compartment, EditorState, StateEffect, StateField } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';

import { cn } from '@/lib/utils';
import { HIGHLIGHTED_LINE_CLASS, codeTheme } from '@/workbench/code-theme';

/**
 * Marks a change the reader did not make, so the update listener can tell a
 * fresh file apart from a keystroke and not report the reload as an edit.
 */
export const ExternalChange = Annotation.define<boolean>();

const setHighlightedLine = StateEffect.define<number | null>();

const highlightedLineMark = Decoration.line({ class: HIGHLIGHTED_LINE_CLASS });

/**
 * The one line `?line=` named, kept as a decoration rather than a class on the
 * DOM: CodeMirror only builds the lines in view, so a line touched by hand is
 * gone the moment it scrolls out and comes back undressed.
 */
const highlightedLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    let next = marks.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setHighlightedLine)) continue;
      const line = effect.value;
      next =
        line == null || line < 1 || line > transaction.state.doc.lines
          ? Decoration.none
          : Decoration.set([highlightedLineMark.range(transaction.state.doc.line(line).from)]);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** What a copy out of the editor is told, before it reaches the clipboard. */
export interface CopiedSelection {
  /** The selected text, exactly as the document has it. */
  text: string;
  /** One-based, inclusive: the first and last line the selection touches. */
  fromLine: number;
  toLine: number;
}

export interface CodeEditorProps {
  /** The file's text. Changing it from outside replaces the document. */
  text: string;
  /** The file's path — the only thing the grammar is chosen by. */
  path: string;
  /** Read-only unless asked; the flip does not rebuild the view. */
  editable?: boolean;
  /** One-based line to scroll to and mark, or nothing. */
  line?: number | null;
  /** Called for every edit the reader makes; never for a reload. */
  onChange?: (text: string) => void;
  /**
   * Given the selection on a copy; whatever it returns is what lands on the
   * clipboard, and returning nothing leaves the text alone.
   */
  onSelectionCopy?: (selection: CopiedSelection) => string | null | undefined;
  className?: string;
}

/**
 * The extensions that are only worth having when the file can be typed into.
 * Kept out of the read-only state so that Ctrl-Z on a file nobody is editing
 * belongs to the browser and Tab still moves the focus out of the pane.
 */
const editableOnly: Extension = [
  history(),
  indentOnInput(),
  rectangularSelection(),
  dropCursor(),
  keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
];

const readOnly: Extension = [EditorState.readOnly.of(true), EditorView.editable.of(false)];

const writable: Extension = [EditorState.readOnly.of(false), EditorView.editable.of(true), editableOnly];

/** The line the position sits on, one-based, the way a reader counts them. */
const lineAt = (state: EditorState, position: number) => state.doc.lineAt(position).number;

export function CodeEditor({
  text,
  path,
  editable = false,
  line = null,
  onChange,
  onSelectionCopy,
  className,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const writing = useRef(new Compartment());
  const painting = useRef(new Compartment());

  // The callbacks are read through refs so that a parent which rebuilds them
  // every render does not rebuild the editor with them.
  const changed = useRef(onChange);
  const copied = useRef(onSelectionCopy);
  changed.current = onChange;
  copied.current = onSelectionCopy;

  // Built once. The props at that moment are the starting state; every later
  // move is an effect below, and none of them may recreate the view.
  const opening = useRef({ text, editable, line });
  opening.current = view.current ? opening.current : { text, editable, line };

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;

    const start = opening.current;
    const state = EditorState.create({
      doc: start.text,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        foldGutter(),
        bracketMatching(),
        highlightSelectionMatches(),
        drawSelection(),
        search(),
        keymap.of(searchKeymap),
        keymap.of(foldKeymap),
        highlightedLineField,
        EditorState.allowMultipleSelections.of(true),
        // Deliberately no `EditorView.lineWrapping`: a wrapped line breaks the
        // one-line-one-number promise the gutter makes, and code is read by it.
        EditorView.clipboardOutputFilter.of((copiedText, copiedState) => {
          const answer = copied.current?.({
            text: copiedText,
            fromLine: lineAt(copiedState, copiedState.selection.main.from),
            toLine: lineAt(copiedState, copiedState.selection.main.to),
          });
          return answer ?? copiedText;
        }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          if (update.transactions.some((transaction) => transaction.annotation(ExternalChange))) return;
          changed.current?.(update.state.doc.toString());
        }),
        language.current.of([]),
        writing.current.of(start.editable ? writable : readOnly),
        painting.current.of(codeTheme),
      ],
    });

    const editor = new EditorView({ state, parent });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  // A new file, or the same file changed on disk: replace the whole document
  // and say who did it, so the change does not come back out as an edit.
  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === text) return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: text },
      annotations: ExternalChange.of(true),
    });
  }, [text]);

  // Read-only and editable are one decision spelled in two facets; a state that
  // sets only one of them either takes keystrokes it will not apply or applies
  // ones it should have refused.
  useEffect(() => {
    view.current?.dispatch({ effects: writing.current.reconfigure(editable ? writable : readOnly) });
  }, [editable]);

  // The grammar arrives late by design — each one is its own chunk, fetched on
  // the first file that needs it — so the file is readable before it is
  // coloured, and a path that lands no grammar simply stays plain.
  useEffect(() => {
    const found = LanguageDescription.matchFilename(languages, path.split('/').pop() ?? path);
    if (!found) {
      view.current?.dispatch({ effects: language.current.reconfigure([]) });
      return;
    }
    let wanted = true;
    void found
      .load()
      .then((support) => {
        if (wanted) view.current?.dispatch({ effects: language.current.reconfigure(support) });
      })
      .catch(() => {
        // A grammar that will not load is not worth a message: the file is
        // already on screen and readable, only uncoloured.
      });
    return () => {
      wanted = false;
    };
  }, [path]);

  // The line named in the address, marked and brought into view. Re-run when
  // the text changes too: the mark is a position, and a document replaced under
  // it is a different document.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const effects: StateEffect<unknown>[] = [setHighlightedLine.of(line)];
    if (line != null && line >= 1 && line <= editor.state.doc.lines) {
      effects.push(EditorView.scrollIntoView(editor.state.doc.line(line).from, { y: 'center' }));
    }
    editor.dispatch({ effects });
  }, [line, text]);

  return <div ref={host} className={cn('min-h-0 overflow-hidden', className)} />;
}
