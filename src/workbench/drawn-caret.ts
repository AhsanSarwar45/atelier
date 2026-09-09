/**
 * The caret both of the app's CodeMirrors draw, in the live theme's ink.
 *
 * Neither editor uses the browser's own caret, and neither can. Both turn on
 * `drawSelection()`, and the first thing that extension does is cover the
 * native one: it installs a `Prec.highest` theme setting
 * `caret-color: transparent !important` on `.cm-content` and `.cm-line`, and
 * paints a `.cm-cursor` element in a layer of its own instead. So a
 * `caretColor` written into either editor's theme is styling something the
 * browser has been told not to draw — dead the moment it is written.
 *
 * That is the right trade to keep: the drawn caret is the one that can be
 * styled at all, the one that appears once per selection range when there is
 * more than one, and the one that sits in the same layer as the drawn
 * selection, so the two agree about where a range begins.
 *
 * What it costs is that its colour is now ours to give. CodeMirror's own
 * baseTheme paints it `1.2px solid black` and only overrides that to `#ddd`
 * under `&dark` — a class it puts on the editor from the `dark` flag passed as
 * the second argument to `EditorView.theme`. An editor built without that flag
 * is a light one as far as CodeMirror is concerned, and its caret is black.
 *
 * The flag is not the answer here even so. This app has eleven skins, four of
 * them light, switched at runtime by an attribute on `<html>`; the flag is
 * fixed when the module is built, so `dark: true` would only move the fault to
 * the light skins. The colour is taken from the live theme's variable instead,
 * exactly the way every other value in code-theme.ts is, and the caret follows
 * a change of skin with nothing dispatched into either editor (bw-axtp.1).
 *
 * 2px rather than CodeMirror's 1.2px: a caret is the one mark on screen a
 * reader hunts for, and half a pixel of it lands between two device pixels and
 * is drawn grey.
 */
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

export const drawnCaret: Extension = EditorView.theme({
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'hsl(var(--text-primary))',
    borderLeftWidth: '2px',
  },
});
