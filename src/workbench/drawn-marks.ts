/**
 * The marks both of the app's CodeMirrors draw for themselves — the caret, and
 * the band under selected text — in the live theme's colours.
 *
 * Neither editor uses the browser's own caret or the browser's own selection,
 * and neither can. Both turn on `drawSelection()`, and the first thing that
 * extension does is cover the native pair: it installs a `Prec.highest` theme
 * setting `caret-color: transparent !important` on `.cm-content` and
 * `.cm-line`, and paints a `.cm-cursor` element and a `.cm-selectionBackground`
 * rectangle in a layer of its own instead. So a `caretColor` written into
 * either editor's theme is styling something the browser has been told not to
 * draw — dead the moment it is written.
 *
 * That is the right trade to keep: the drawn marks are the ones that can be
 * styled at all, the ones that appear once per range when there is more than
 * one, and they sit in the same layer, so the two agree about where a range
 * begins.
 *
 * What it costs is that their colours are now ours to give. CodeMirror's own
 * baseTheme paints the caret `1.2px solid black` and the band `#d7d4f0`, and
 * only overrides those under `&dark` — a class it puts on the editor from the
 * `dark` flag passed as the second argument to `EditorView.theme`. An editor
 * built without that flag is a light one as far as CodeMirror is concerned:
 * black caret, pale lavender band.
 *
 * The flag is not the answer here even so. This app has eleven skins, four of
 * them light, switched at runtime by an attribute on `<html>`; the flag is
 * fixed when the module is built, so `dark: true` would only move the fault to
 * the light skins. The colours are taken from the live theme's variables
 * instead, exactly the way every other value in code-theme.ts is, and both
 * marks follow a change of skin with nothing dispatched into either editor
 * (bw-axtp.1).
 *
 * 2px rather than CodeMirror's 1.2px: a caret is the one mark on screen a
 * reader hunts for, and half a pixel of it lands between two device pixels and
 * is drawn grey.
 */
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/**
 * The band, at the same strength as every other wash of `--info` in the app
 * (`--color-info-soft` in globals.css is `hsl(var(--info) / 0.18)`).
 *
 * The strength is the whole of this decision, because a selection has two sides
 * and they pull against each other: the band has to be visible against the box,
 * which wants it darker, and the writing has to stay readable ON it, which
 * wants it lighter. Measured across four skins in both editors (bw-axtp.3),
 * 0.18 is the last step at which every skin still clears AA's 4.5:1 for the
 * writing — Frappé's Files tab, the tightest of the eight readings, sits at
 * 4.72:1 here and falls to 4.43:1 at 0.22 and 3.68:1 at 0.3. The band itself
 * lands between 1.21:1 and 1.46:1 against its box, which is where an ordinary
 * editor's selection sits.
 *
 * Text you cannot read is worse than a band you have to look for, and 4.5:1 is
 * a standard where the band's own number is a judgement, so the tie is broken
 * towards the writing.
 *
 * The Files tab carried `hsl(var(--info) / 0.3)` in its own theme until now,
 * and it only ever showed while that view was unfocused: CodeMirror's baseTheme
 * paints the focused band through
 * `&light.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground`,
 * four classes deep, and beat the two-class rule that was answering it. The
 * selector below is the same shape as CodeMirror's own, which is what it takes
 * to be heard while the view has focus.
 */
const BAND = 'hsl(var(--info) / 0.18)';

export const drawnMarks: Extension = EditorView.theme({
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'hsl(var(--text-primary))',
    borderLeftWidth: '2px',
  },
  // Said twice on purpose. CodeMirror paints an unfocused selection too, from a
  // rule of its own, and the Files tab is read-only at rest — a band that only
  // showed while the view had focus would vanish the moment a reader reached
  // for anything else. `::selection` is the third case: text that the drawn
  // layer does not cover, copied out of the editor by the browser.
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: BAND,
  },
  '.cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: BAND,
  },
});
