/**
 * What the floating window promises: it goes where you drag it, it is the size
 * you pull it to, it comes back to the shape it had before it filled the
 * screen, and on a phone it is the screen and cannot be dragged anywhere.
 *
 * jsdom has no layout, so every number here comes from what the window itself
 * wrote into its inline style, and the viewport is the one this file hands it.
 * That is the whole of what the window computes — it reads `innerWidth` and the
 * pointer, never `getBoundingClientRect` — so these are its real sums and not a
 * stand-in for them. What is NOT proved here is anything the browser draws:
 * whether the box is over the app's bars, whether the edges are grabbable, and
 * whether "fills the screen" fills it. Those need a real browser.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TerminalWindow } from '@/workbench/terminal-window';

/**
 * jsdom answers no media queries at all, so the window would think every screen
 * was a wide one. This is the smallest honest stand-in: it answers the query it
 * is given against the width this file has set.
 */
function setViewport(width: number, height: number) {
  Object.assign(window, {
    innerWidth: width,
    innerHeight: height,
    matchMedia: (query: string) => {
      const limit = Number(/max-width:\s*(\d+)/.exec(query)?.[1] ?? NaN);
      return {
        media: query,
        get matches() {
          return Number.isFinite(limit) && window.innerWidth <= limit;
        },
        addEventListener() {},
        removeEventListener() {},
      };
    },
  });
}

/** jsdom has no pointer capture either; the drag needs it to exist to ask for it. */
function grip(testId: string) {
  const element = screen.getByTestId(testId);
  Object.assign(element, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
  return element;
}

const draw = (onClose = vi.fn()) =>
  render(
    <TerminalWindow title="Terminal" onClose={onClose}>
      <div data-testid="the-work">output</div>
    </TerminalWindow>,
  );

const shape = () => {
  const box = screen.getByTestId('terminal-window');
  return {
    x: parseFloat(box.style.left),
    y: parseFloat(box.style.top),
    width: parseFloat(box.style.width),
    height: parseFloat(box.style.height),
  };
};

function dragBy(element: HTMLElement, dx: number, dy: number, from = { x: 500, y: 500 }) {
  fireEvent.pointerDown(element, { pointerId: 1, button: 0, clientX: from.x, clientY: from.y });
  fireEvent.pointerMove(element, { pointerId: 1, clientX: from.x + dx, clientY: from.y + dy });
  fireEvent.pointerUp(element, { pointerId: 1, clientX: from.x + dx, clientY: from.y + dy });
}

beforeEach(() => setViewport(1200, 800));

describe('the floating terminal window', () => {
  it('goes where its title bar is dragged', () => {
    draw();
    const before = shape();
    dragBy(grip('terminal-window-handle'), 60, 40);
    const after = shape();
    expect(after.x - before.x, 'a drag 60 to the right should move the window 60 to the right').toBe(60);
    expect(after.y - before.y, 'a drag 40 down should move the window 40 down').toBe(40);
    expect({ width: after.width, height: after.height }, 'moving a window must not resize it').toEqual({
      width: before.width,
      height: before.height,
    });
  });

  it('keeps hold of a pointer that runs off the edge of it', () => {
    draw();
    const bar = grip('terminal-window-handle');
    fireEvent.pointerDown(bar, { pointerId: 7, button: 0, clientX: 500, clientY: 500 });
    expect(bar.setPointerCapture, 'the bar must capture the pointer or a fast drag is dropped').toHaveBeenCalledWith(7);
    // The pointer is now nowhere near the window; it must still be following.
    fireEvent.pointerMove(bar, { pointerId: 7, clientX: 900, clientY: 300 });
    expect(shape().x, 'a pointer outside the window still drags it').toBe(220 + 400);
  });

  it('does not move when the work inside it is dragged', () => {
    draw();
    const before = shape();
    const body = screen.getByTestId('terminal-window-body');
    Object.assign(body, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
    dragBy(body, 120, 90);
    expect(shape(), 'dragging inside the window belongs to the terminal, not to the window').toEqual(before);
  });

  it('is the width you pull its right edge to', () => {
    draw();
    const before = shape();
    dragBy(grip('terminal-window-resize-e'), 120, 0);
    const after = shape();
    expect(after.width - before.width, 'pulling the right edge 120 out should add 120 of width').toBe(120);
    expect(after.x, 'pulling the right edge must not move the left one').toBe(before.x);
  });

  it('is the height you pull its bottom edge to', () => {
    draw();
    const before = shape();
    dragBy(grip('terminal-window-resize-s'), 0, -75);
    const after = shape();
    expect(after.height - before.height, 'pushing the bottom edge 75 up should take 75 of height').toBe(-75);
    expect(after.y, 'pushing the bottom edge must not move the top one').toBe(before.y);
  });

  it('holds the far edge still while the near one moves', () => {
    draw();
    const before = shape();
    dragBy(grip('terminal-window-resize-w'), 100, 0);
    const after = shape();
    expect(after.x - before.x, 'pushing the left edge 100 in should move it 100 in').toBe(100);
    expect(after.x + after.width, 'the right edge must not have moved at all').toBe(before.x + before.width);
  });

  it('refuses to shrink to nothing', () => {
    draw();
    dragBy(grip('terminal-window-resize-se'), -2000, -2000);
    const after = shape();
    expect(after.width, 'a window has to stay wide enough to grab').toBe(320);
    expect(after.height, 'a window has to stay tall enough to grab').toBe(180);
  });

  it('fills the screen and comes back to the exact shape it left', () => {
    draw();
    dragBy(grip('terminal-window-handle'), -80, -140);
    dragBy(grip('terminal-window-resize-e'), 55, 0);
    const before = shape();
    expect(before, 'the test needs a shape that is nobody default').toEqual({ x: 140, y: 216, width: 815, height: 420 });

    fireEvent.click(screen.getByRole('button', { name: 'Fill the screen with Terminal' }));
    expect(shape(), 'filled means the whole screen, corner to corner').toEqual({ x: 0, y: 0, width: 1200, height: 800 });

    fireEvent.click(screen.getByRole('button', { name: 'Put Terminal back' }));
    expect(shape(), 'coming back means the shape it had, not a fresh default').toEqual(before);
  });

  it('has nothing to drag while it is filling the screen', () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Fill the screen with Terminal' }));
    expect(
      screen.queryByTestId('terminal-window-handle'),
      'a filled window has nowhere to be dragged to',
    ).toBeNull();
    expect(screen.queryByTestId('terminal-window-resize-e'), 'nor any edge left to pull').toBeNull();
  });

  it('never lets its title bar off the screen', () => {
    draw();
    dragBy(grip('terminal-window-handle'), -5000, -5000);
    const away = shape();
    expect(away.x, 'the width of a fingertip stays on screen at the left').toBe(96 - away.width);
    expect(away.y, 'the bar can never go above the top edge, where nothing could grab it').toBe(0);

    dragBy(grip('terminal-window-handle'), 5000, 5000);
    const far = shape();
    expect(far.x, 'the same at the right').toBe(1200 - 96);
    expect(far.y, 'and the bar stops on the bottom edge rather than below it').toBe(800 - 36);
  });

  it('comes back into reach when the browser window is made smaller', () => {
    draw();
    dragBy(grip('terminal-window-handle'), 5000, 5000);
    expect(shape().x, 'it starts against the right edge of a wide screen').toBe(1104);

    setViewport(700, 500);
    fireEvent(window, new Event('resize'));
    const after = shape();
    expect(after.x, 'a narrower browser window must not leave it out of reach').toBe(700 - 96);
    expect(after.y, 'nor below the bottom of a shorter one').toBe(500 - 36);
  });

  it('grows with the screen while it is filled', () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Fill the screen with Terminal' }));
    setViewport(1400, 900);
    fireEvent(window, new Event('resize'));
    expect(shape(), 'filled means filled, whatever size the screen becomes').toEqual({
      x: 0,
      y: 0,
      width: 1400,
      height: 900,
    });
  });

  it('moves with the arrow keys', () => {
    draw();
    const before = shape();
    const bar = screen.getByTestId('terminal-window-handle');
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    fireEvent.keyDown(bar, { key: 'ArrowUp' });
    const after = shape();
    expect(after.x - before.x, 'right arrow moves it a step right').toBe(16);
    expect(after.y - before.y, 'up arrow moves it a step up').toBe(-16);
  });

  it('resizes with the arrow keys from an edge, along that edge only', () => {
    draw();
    const before = shape();
    const edge = screen.getByRole('separator', { name: 'Resize Terminal from the right edge' });
    fireEvent.keyDown(edge, { key: 'ArrowRight' });
    expect(shape().width - before.width, 'right arrow on the right edge widens it a step').toBe(16);
    fireEvent.keyDown(edge, { key: 'ArrowDown' });
    expect(shape().height, 'down arrow on a side edge is not for it to answer').toBe(before.height);
  });

  it('puts itself back when Escape interrupts a drag', () => {
    draw();
    const before = shape();
    const bar = grip('terminal-window-handle');
    fireEvent.pointerDown(bar, { pointerId: 3, button: 0, clientX: 500, clientY: 500 });
    fireEvent.pointerMove(bar, { pointerId: 3, clientX: 600, clientY: 600 });
    expect(shape().x, 'the drag is under way').toBe(before.x + 100);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(shape(), 'Escape abandons the drag and puts the window back').toEqual(before);

    fireEvent.pointerMove(bar, { pointerId: 3, clientX: 700, clientY: 700 });
    expect(shape(), 'and the abandoned drag does not pick up again').toEqual(before);
  });

  it('leaves Escape to the terminal when nothing is being dragged', () => {
    const closed = vi.fn();
    draw(closed);
    const before = shape();
    fireEvent.keyDown(screen.getByTestId('terminal-window-body'), { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(closed, 'Escape belongs to whatever is running in the window, so it must not close it').not.toHaveBeenCalled();
    expect(screen.getByTestId('terminal-window'), 'and the window is still open').toBeInTheDocument();
    expect(shape(), 'and has not moved').toEqual(before);
  });

  it('closes from the cross in its bar', () => {
    const closed = vi.fn();
    draw(closed);
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal' }));
    expect(closed, 'the visible way out is the one that works').toHaveBeenCalledTimes(1);
  });

  it('draws itself in the page rather than where it was written', () => {
    const { container } = render(
      <div className="overflow-hidden">
        <TerminalWindow title="Terminal" onClose={vi.fn()}>
          <div />
        </TerminalWindow>
      </div>,
    );
    expect(
      container.querySelector('[data-testid="terminal-window"]'),
      'a window drawn inside a pane that clips is a window with its corners cut off',
    ).toBeNull();
    expect(document.body.querySelector('[data-testid="terminal-window"]'), 'it belongs to the page').not.toBeNull();
  });
});

describe('the terminal window on a phone', () => {
  beforeEach(() => setViewport(390, 760));

  it('fills the screen, with nothing to drag and no edges to pull', () => {
    draw();
    const box = screen.getByTestId('terminal-window');
    expect(box.className, 'below the app’s narrow breakpoint the screen is the window').toContain('inset-0');
    expect(box.style.left, 'so it is not placed anywhere; it is everywhere').toBe('');
    expect(box.style.width, 'and it is not sized; it is the screen').toBe('');
    expect(
      screen.queryByTestId('terminal-window-handle'),
      'dragging a full-screen window is a gesture with nowhere to go',
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move Terminal' }), 'and no way to ask for one').toBeNull();
    for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      expect(screen.queryByTestId(`terminal-window-resize-${edge}`), `no ${edge} edge to pull either`).toBeNull();
    }
    expect(
      screen.queryByRole('button', { name: /Fill the screen/ }),
      'nothing to fill: it already is the screen',
    ).toBeNull();
  });

  it('still shows the work and the way out', () => {
    const closed = vi.fn();
    draw(closed);
    expect(screen.getByTestId('the-work'), 'the window is still a window').toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal' }));
    expect(closed, 'and the cross is the only way out it has').toHaveBeenCalledTimes(1);
  });
});
