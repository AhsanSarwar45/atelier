/**
 * How code is painted inside CodeMirror, in the app's own colours.
 *
 * Both halves are built once, at module scope, and never again: a theme is a
 * StyleModule, and building a new one per render leaks a stylesheet per render.
 * That is affordable here because not one value below is a colour — every one
 * is a `var(--…)` read out of the live theme. style-mod writes what it is given
 * straight into the sheet, so the browser resolves each variable against the
 * `<html>` the rule is matched on, and switching skin repaints the code with
 * nothing dispatched into the editor at all.
 *
 * The app's variables are HSL triplets, so they are spelled `hsl(var(--x))`,
 * and `hsl(var(--x) / 0.3)` where a wash over the page is wanted.
 *
 * The token colours are their own set of variables (`--code-*`, defined in
 * globals.css with per-theme overrides in themes.css) because the surface
 * palette has no word for "string" or "keyword": reusing `--info` for functions
 * and `--success` for strings reads as a status report, not as code, and on the
 * light skins it is unreadable.
 */
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

import { drawnCaret } from '@/workbench/drawn-caret';

/** The class a line named by `?line=` wears; the rule for it lives below. */
export const HIGHLIGHTED_LINE_CLASS = 'cm-highlighted-line';

/** Surfaces, gutters, selection and the search panel, in the live theme. */
export const codeSurfaceTheme = EditorView.theme({
  '&': {
    color: 'hsl(var(--text-secondary))',
    backgroundColor: 'hsl(var(--surface-base))',
    height: '100%',
    fontSize: '0.8125rem',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.55',
    overflow: 'auto',
  },
  // No caretColor here: drawSelection() covers the native caret with
  // `caret-color: transparent !important`, and drawn-caret.ts paints the
  // element it draws in its place — for this view and for the chat's box
  // alike (bw-axtp.1).
  '.cm-content': {
    padding: '0.5rem 0',
  },
  // Read-only is the resting state, so the selection has to be visible without
  // focus; CM only paints its own layer when focused unless it is told twice.
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'hsl(var(--info) / 0.3)',
  },
  '.cm-gutters': {
    backgroundColor: 'hsl(var(--surface-base))',
    color: 'hsl(var(--text-faint))',
    borderRight: '1px solid hsl(var(--border-subtle))',
    userSelect: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 0.75rem 0 1rem',
    minWidth: '2.5rem',
  },
  '.cm-foldGutter .cm-gutterElement': {
    padding: '0 0.25rem',
    color: 'hsl(var(--text-faint))',
  },
  '.cm-foldGutter .cm-gutterElement:hover': {
    color: 'hsl(var(--text-secondary))',
  },
  '.cm-activeLine': {
    backgroundColor: 'hsl(var(--surface-raised) / 0.6)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'hsl(var(--surface-raised) / 0.6)',
    color: 'hsl(var(--text-tertiary))',
  },
  [`.${HIGHLIGHTED_LINE_CLASS}`]: {
    backgroundColor: 'hsl(var(--warning) / 0.16)',
    boxShadow: 'inset 2px 0 0 0 hsl(var(--warning))',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'hsl(var(--info) / 0.22)',
    borderRadius: '2px',
  },
  '.cm-searchMatch': {
    backgroundColor: 'hsl(var(--warning) / 0.28)',
    outline: '1px solid hsl(var(--warning) / 0.5)',
    borderRadius: '2px',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'hsl(var(--warning) / 0.5)',
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'hsl(var(--info) / 0.25)',
    outline: 'none',
  },
  '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': {
    backgroundColor: 'hsl(var(--danger) / 0.25)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'hsl(var(--surface-inset))',
    color: 'hsl(var(--text-muted))',
    border: '1px solid hsl(var(--border-default))',
    borderRadius: '3px',
    padding: '0 0.25rem',
    margin: '0 0.25rem',
  },
  '.cm-panels': {
    backgroundColor: 'hsl(var(--surface-overlay))',
    color: 'hsl(var(--text-secondary))',
    borderTop: '1px solid hsl(var(--border-default))',
    borderBottom: '1px solid hsl(var(--border-default))',
    fontFamily: 'var(--font-body)',
  },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': {
    fontSize: '0.75rem',
  },
  '.cm-panel.cm-search input[type=text]': {
    backgroundColor: 'hsl(var(--surface-base))',
    color: 'hsl(var(--text-primary))',
    border: '1px solid hsl(var(--border-default))',
    borderRadius: '4px',
    padding: '0.125rem 0.375rem',
  },
  '.cm-panel.cm-search button[name]': {
    backgroundColor: 'hsl(var(--surface-inset))',
    backgroundImage: 'none',
    color: 'hsl(var(--text-secondary))',
    border: '1px solid hsl(var(--border-default))',
    borderRadius: '4px',
    padding: '0.125rem 0.5rem',
  },
  '.cm-panel.cm-search button[name]:hover': {
    backgroundColor: 'hsl(var(--surface-overlay))',
    color: 'hsl(var(--text-primary))',
  },
  '.cm-panel.cm-search .cm-button': {
    backgroundImage: 'none',
  },
  '.cm-tooltip': {
    backgroundColor: 'hsl(var(--surface-overlay))',
    color: 'hsl(var(--text-secondary))',
    border: '1px solid hsl(var(--border-default))',
    borderRadius: '6px',
  },
});

const ink = (name: string) => `hsl(var(--code-${name}))`;

/**
 * Which lezer tag is painted with which of the twelve `--code-*` inks.
 *
 * Twelve is deliberately few. A grammar names dozens of tags and a palette that
 * answers each one separately cannot be checked against eleven skins by eye;
 * this set is the one every editor's own theme actually distinguishes.
 */
export const codeHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], color: ink('keyword') },
  { tag: [t.string, t.special(t.string), t.regexp, t.attributeValue], color: ink('string') },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta], color: ink('comment'), fontStyle: 'italic' },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom, t.escape, t.character], color: ink('number') },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName), t.definition(t.typeName)], color: ink('type') },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName, t.labelName], color: ink('function') },
  { tag: [t.variableName, t.propertyName, t.definition(t.variableName), t.local(t.variableName), t.self], color: ink('variable') },
  {
    tag: [t.operator, t.derefOperator, t.compareOperator, t.logicOperator, t.arithmeticOperator, t.bitwiseOperator, t.updateOperator, t.definitionOperator],
    color: ink('operator'),
  },
  { tag: [t.punctuation, t.separator, t.bracket, t.paren, t.brace, t.squareBracket, t.angleBracket, t.processingInstruction], color: ink('punctuation') },
  { tag: [t.tagName, t.standard(t.tagName), t.special(t.tagName)], color: ink('tag') },
  { tag: [t.attributeName, t.modifier, t.annotation], color: ink('attribute') },
  { tag: [t.invalid, t.deleted], color: ink('invalid') },

  // Prose inside a grammar — Markdown, a doc comment — still has to read.
  { tag: t.heading, color: ink('function'), fontWeight: '600' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: ink('operator'), textDecoration: 'underline' },
  { tag: t.quote, color: ink('comment') },
  { tag: t.monospace, color: ink('string') },
  { tag: t.inserted, color: ink('string') },
]);

/** The whole look, ready to hand to a Compartment. */
export const codeTheme: Extension = [codeSurfaceTheme, drawnCaret, syntaxHighlighting(codeHighlightStyle)];
