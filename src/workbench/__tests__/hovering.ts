/**
 * What a hover says, now that every hover label in the app is drawn by one
 * component rather than by the browser (bw-6wq6.2).
 *
 * A `title` was in the markup whether or not anybody was pointing at it, so a
 * case could read it straight off the element. The app's own label does not
 * exist until the pointer is on the control and the delay has passed, so
 * reading it means doing what the reader does.
 */
import { fireEvent, screen } from '@testing-library/react';

/** Point at `el` and give back the words the label that opens says. */
export async function hoverSays(el: Element): Promise<string> {
  // Radix opens on a pointer that is moving over the trigger, which `hover`
  // and `mouseEnter` are not; this is the event it listens for.
  fireEvent.pointerMove(el, { pointerType: 'mouse' });
  // A case that walks along a row of chips can catch the label it is leaving
  // still on screen, so the newest one is the one it asked for.
  const labels = await screen.findAllByRole('tooltip', {}, { timeout: 2000 });
  return labels.at(-1)?.textContent ?? '';
}
