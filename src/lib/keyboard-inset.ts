/**
 * Where the phone keyboard is, in one place.
 *
 * A keyboard is drawn over the page, not beside it. Nothing about the layout
 * says so: `window.innerHeight` is the same 844 with the keyboard up as with it
 * down, and so is `100dvh`, so an app that fills the window puts its writing
 * box under the keyboard the moment the writing box is what you tapped. The
 * survey measured exactly that at 390x844 — the composer drawn from y=736 to
 * y=832 with only y<508 left to look at (bw-e3dw.1).
 *
 * `window.visualViewport` is the one thing that does say: it is the part of the
 * page the reader can actually see, and the keyboard is the difference between
 * it and the window. So the inset is published once, as a custom property on
 * the document, and anything that has to stay out from under the keyboard —
 * the shell's own height, the `@` menu's placement — reads that instead of
 * measuring for itself. One answer to "where is the keyboard", the way
 * `screen-width.ts` is the one answer to "is this a phone".
 *
 * Two things it deliberately does not call a keyboard: a pinch, which shrinks
 * the visual viewport with no keyboard anywhere (so a scale above 1 reports
 * nothing), and the handful of pixels of rounding a browser leaves between the
 * two viewports at rest.
 */

/** The custom property the inset is published under. */
export const KEYBOARD_INSET = '--keyboard-inset';

/** Below this, the difference between the two viewports is rounding. */
const NOISE = 4;

/** How much of the bottom of the window is covered right now, in pixels. */
export function keyboardInset(): number {
  if (typeof window === 'undefined') return 0;
  const seen = window.visualViewport;
  if (!seen || seen.scale > 1.01) return 0;
  const covered = window.innerHeight - (seen.height + seen.offsetTop);
  return covered > NOISE ? Math.round(covered) : 0;
}

/**
 * Keep the custom property up to date until the returned function is called.
 *
 * Safe to start more than once: every caller writes the same number to the same
 * property, and the last one to stop leaves it at zero.
 */
export function watchKeyboard(): () => void {
  if (typeof window === 'undefined') return () => {};
  const publish = () => document.documentElement.style.setProperty(KEYBOARD_INSET, `${keyboardInset()}px`);
  publish();
  const seen = window.visualViewport;
  // `scroll` as well as `resize`: on the phones that move the visual viewport
  // rather than shortening it, the offset is the whole of the news.
  seen?.addEventListener('resize', publish);
  seen?.addEventListener('scroll', publish);
  window.addEventListener('resize', publish);
  return () => {
    seen?.removeEventListener('resize', publish);
    seen?.removeEventListener('scroll', publish);
    window.removeEventListener('resize', publish);
    document.documentElement.style.setProperty(KEYBOARD_INSET, '0px');
  };
}
