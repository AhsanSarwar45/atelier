/**
 * Whether a scrolling pane is being watched at its end.
 *
 * A chat followed its own end on every change to the transcript and never asked
 * where the reader was, so reading history while the agent answered meant being
 * dragged back down on every word of it (bw-n6yh). The reader decides, and what
 * decides it is where the pane actually is — so these are the answers the rest
 * of the chat is built on: he scrolled away, he came back, the app moved the
 * pane where it meant to, and the pane itself only appeared on a later frame.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useHeldAtTheEnd } from '../held-at-the-end';

/** How tall the conversation is, and how much of it can be seen at once. */
let tall = 1000;
let seen = 400;
/** Where the pane sits when its end is in view, as things stand. */
const end = () => tall - seen;
const END = 600;

let box: HTMLDivElement;
let at = 0;
/** Where the chat keeps its own pane, handed to the hook as a chat hands it. */
let held: { current: HTMLElement | null };
/** Frames the browser has been asked for and has not yet drawn. */
let frames: FrameRequestCallback[] = [];

/** The browser draws the frame it was asked for. */
function frame() {
  const owed = frames;
  frames = [];
  owed.forEach((f) => f(0));
}

/**
 * A pane with a size. jsdom lays nothing out, so every measurement a real pane
 * answers is answered here instead — including its place, which jsdom otherwise
 * holds at zero however it is set.
 */
function pane(): HTMLDivElement {
  const made = document.createElement('div');
  at = 0;
  Object.defineProperty(made, 'scrollHeight', { get: () => tall });
  Object.defineProperty(made, 'clientHeight', { get: () => seen });
  Object.defineProperty(made, 'scrollTop', { get: () => at, set: (to: number) => (at = to) });
  // A pane can only go as far as it can go: asked past its own end, the browser
  // stops at the end and says so when it arrives.
  Object.assign(made, {
    scrollTo: ({ top }: ScrollToOptions) => {
      at = Math.min(Math.max(0, top ?? 0), end());
      made.dispatchEvent(new Event('scroll'));
    },
  });
  document.body.appendChild(made);
  return made;
}

/**
 * The hook, with the pane put on it the way React puts it on: not on the first
 * render, because a chat draws its 'pick a project' line before it has a pane
 * at all.
 */
function watching() {
  const watch = renderHook(() => useHeldAtTheEnd(held));
  act(() => watch.result.current.paneRef(box));
  return watch;
}

/** The reader takes the pane somewhere with his wheel. */
function scrolls(to: number) {
  act(() => {
    box.dispatchEvent(new Event('wheel'));
    at = to;
    box.dispatchEvent(new Event('scroll'));
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  tall = 1000;
  seen = 400;
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => {
    frames.push(f);
    return frames.length;
  });
  box = pane();
  held = { current: null };
});

describe('whether the reader is watching the end', () => {
  it('opens at the end, watching it', () => {
    const { result } = watching();
    expect(at).toBe(END);
    expect(result.current.held).toBe(true);
  });

  it('lets go the moment he scrolls away from it', () => {
    const { result } = watching();
    scrolls(0);
    expect(result.current.held).toBe(false);
  });

  it('lets go on upward intent even when the loaded page cannot move yet', () => {
    tall = seen;
    const { result, rerender } = watching();
    expect(at).toBe(0);
    expect(result.current.held).toBe(true);

    act(() => box.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 })));
    expect(result.current.held).toBe(false);

    tall += 400;
    act(() => rerender());
    expect(at).toBe(0);
  });

  it('keeps hold while he is only a little way off the end', () => {
    const { result } = watching();
    scrolls(END - 40);
    expect(result.current.held).toBe(true);
  });

  it('takes hold again when he comes back to it', () => {
    const { result } = watching();
    scrolls(0);
    expect(result.current.held).toBe(false);
    scrolls(END);
    expect(result.current.held).toBe(true);
  });

  it('leaves the answer as it was when the app moved the pane where it meant to', () => {
    const { result } = watching();
    // What following the end does between two frames: the pane is moved, and
    // the scroll it causes is not the reader saying anything.
    act(() => {
      result.current.toTheEnd();
      box.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.held).toBe(true);
  });

  it('calls a move his when it lands anywhere the app was not aiming', () => {
    const { result } = watching();
    // Dragging the scrollbar: no wheel, no key, nothing but the pane ending up
    // somewhere nobody aimed it.
    act(() => {
      at = 0;
      box.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.held).toBe(false);
  });

  it('puts the end back in view and follows it again', () => {
    const { result } = watching();
    scrolls(0);
    expect(result.current.held).toBe(false);
    act(() => result.current.toTheEnd());
    expect(at).toBe(END);
    expect(result.current.held).toBe(true);
  });

  it('arrives even though taking hold brought the end nearer, and follows again after', () => {
    // The way back to now gives up its own strip of screen as it goes, so the
    // pane grows taller and its end moves up by that much while the move is in
    // the air. Aimed at where the end was, the pane stops short of it for ever
    // and the chat is left gliding — following nothing, until he touches it
    // again (bw-n6yh.10).
    const { result, rerender } = watching();
    scrolls(0);
    act(() => result.current.toTheEnd('smooth'));
    seen += 48;
    act(() => frame());
    expect(at).toBe(end());
    expect(result.current.held).toBe(true);
    // And a word arriving after it is followed, which is what being left
    // gliding took away.
    tall += 100;
    act(() => rerender());
    expect(at).toBe(end());
  });

  it('notices the reader even though the pane only appeared on a later frame', () => {
    // The whole hook was silently dead this way: a chat has no pane on its
    // first render, and everything here waited on that render alone.
    const { result } = renderHook(() => useHeldAtTheEnd(held));
    expect(held.current).toBeNull();
    act(() => result.current.paneRef(box));
    expect(held.current).toBe(box);
    scrolls(0);
    expect(result.current.held).toBe(false);
  });
});
