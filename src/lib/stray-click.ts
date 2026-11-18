/**
 * The click a tap sends after its lift, kept from landing behind a popup.
 *
 * A browser sends a tap's `click` a moment after the finger lifts, aimed at
 * whatever is under the finger by then. A popup that acts on the lift and
 * closes leaves that click to land on the page behind it: tapping a line of
 * the `@` menu also pressed the sidebar button or the message under the menu.
 * `preventDefault` on the pointer events does not stop it; only the click
 * itself can be stopped.
 *
 * So the next click near the lift is swallowed on the window, before anything
 * on the page hears it. Only a click near the point counts, and only for a
 * short while, so a tap somewhere else afterwards is never lost.
 */

/** How long after the lift the browser's click can still arrive. */
const CLICK_DELAY = 700;
/** How far from the lift the click can land and still be the same tap. */
const NEAR = 24;

export function swallowClickAt(x: number, y: number): void {
  const swallow = (event: MouseEvent) => {
    if (Math.abs(event.clientX - x) > NEAR || Math.abs(event.clientY - y) > NEAR) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    done();
  };
  const done = () => {
    clearTimeout(timer);
    window.removeEventListener('click', swallow, true);
  };
  window.addEventListener('click', swallow, true);
  const timer = setTimeout(done, CLICK_DELAY);
}
