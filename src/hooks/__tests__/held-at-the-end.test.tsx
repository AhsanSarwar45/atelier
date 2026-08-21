/**
 * Whether a scrolling pane is being watched at its end.
 *
 * A chat followed its own end on every change to the transcript and never asked
 * where the reader was, so reading history while the agent answered meant being
 * dragged back down on every word of it (bw-n6yh). The reader decides, and what
 * decides it is where the pane actually is — so these are the three answers the
 * rest of the chat is built on: he scrolled away, he came back, and the app
 * moved the pane itself, which says nothing about him either way.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useHeldAtTheEnd } from '../held-at-the-end';

/** How tall the conversation is, and how much of it can be seen at once. */
const TALL = 1000;
const SEEN = 400;
/** Where the pane sits when its end is in view. */
const END = TALL - SEEN;

let box: HTMLDivElement;
let at = 0;
/** The pane the hook is handed, made once and kept, as a real one is. */
let held: { current: HTMLElement | null };

/**
 * A pane with a size. jsdom lays nothing out, so every measurement a real pane
 * answers is answered here instead — including its place, which jsdom otherwise
 * holds at zero however it is set.
 */
function pane(): { current: HTMLElement | null } {
  box = document.createElement('div');
  at = 0;
  Object.defineProperty(box, 'scrollHeight', { get: () => TALL });
  Object.defineProperty(box, 'clientHeight', { get: () => SEEN });
  Object.defineProperty(box, 'scrollTop', { get: () => at, set: (to: number) => (at = to) });
  document.body.appendChild(box);
  return { current: box };
}

/** The hook over that pane, handed the same one on every pass as a chat does. */
function watching() {
  return renderHook(() => useHeldAtTheEnd(held));
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
  held = pane();
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

  it('leaves the answer as it was when the app moved the pane itself', () => {
    const { result } = watching();
    // What holding his place among older messages does: the pane is moved a
    // long way from the end, and he never touched it.
    act(() => {
      result.current.quiet(() => {
        at = 0;
      });
      box.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.held).toBe(true);
  });

  it('stops calling a move the app’s once he takes the pane over', () => {
    const { result } = watching();
    act(() => {
      result.current.quiet(() => {
        at = 0;
      });
    });
    scrolls(0);
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
});
