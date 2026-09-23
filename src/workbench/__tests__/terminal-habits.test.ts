/**
 * The desktop-terminal habits the pane is taught: which presses are clipboard
 * chords, and a finger's drag turned into the wheel xterm scrolls on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { chord, shellClipboard, touchScroll } from '@/workbench/terminal-habits';

import type { Terminal } from '@xterm/xterm';


function press(code: string, mods: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { code, ...mods });
}

function touch(type: string, clientY: number, target: HTMLElement): TouchEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  const touches = type === 'touchend' ? [] : [{ clientX: 5, clientY }];
  Object.defineProperty(event, 'touches', { value: touches });
  target.dispatchEvent(event);
  return event;
}

describe('the clipboard chords', () => {
  it('reads Ctrl+Shift+C and Ctrl+Insert as copy, Ctrl+Shift+V and Shift+Insert as paste', () => {
    expect(chord(press('KeyC', { ctrlKey: true, shiftKey: true }))).toBe('copy');
    expect(chord(press('Insert', { ctrlKey: true }))).toBe('copy');
    expect(chord(press('KeyV', { ctrlKey: true, shiftKey: true }))).toBe('paste');
    expect(chord(press('Insert', { shiftKey: true }))).toBe('paste');
  });

  it('leaves Ctrl+C and Ctrl+V to the shell, as an interrupt and a literal next', () => {
    expect(chord(press('KeyC', { ctrlKey: true }))).toBeNull();
    expect(chord(press('KeyV', { ctrlKey: true }))).toBeNull();
    expect(chord(press('KeyC', { ctrlKey: true, shiftKey: true, altKey: true }))).toBeNull();
    expect(chord(press('Insert'))).toBeNull();
  });
});

/**
 * The part of a terminal a drag consults: ten rows in a 200-pixel grid, so a
 * line is 20 pixels, in whichever buffer and mouse mode a case says.
 */
function grid(buffer: 'normal' | 'alternate' = 'normal', mouse = 'none') {
  const screen = document.createElement('div');
  Object.defineProperty(screen, 'clientHeight', { value: 200 });
  const term = {
    rows: 10,
    modes: { mouseTrackingMode: mouse },
    buffer: { active: { type: buffer } },
    scrollLines: vi.fn(),
  };
  const wheels: number[] = [];
  screen.addEventListener('wheel', (event) => {
    const wheel = event as WheelEvent;
    expect(wheel.deltaMode).toBe(WheelEvent.DOM_DELTA_LINE);
    wheels.push(wheel.deltaY);
  });
  return { screen, term, wheels, stop: touchScroll(term as unknown as Terminal, screen) };
}

describe('the clipboard a program in the shell can reach', () => {
  it('can be written but never read', async () => {
    expect(await shellClipboard.readText('c' as Parameters<typeof shellClipboard.readText>[0])).toBe('');
  });
});

describe('a finger dragged on the grid', () => {
  let stop: (() => void) | null = null;
  afterEach(() => stop?.());

  it('scrolls back a line for every line dragged down, and never scrolls the page', () => {
    const it = grid();
    stop = it.stop;

    touch('touchstart', 300, it.screen);
    const down = touch('touchmove', 345, it.screen); // two lines and a bit
    touch('touchmove', 360, it.screen); // the bit, and most of another
    const up = touch('touchmove', 300, it.screen); // three lines the other way
    touch('touchend', 0, it.screen);

    expect(it.term.scrollLines.mock.calls.map((call) => call[0])).toEqual([-2, -1, 3]);
    expect(down.defaultPrevented && up.defaultPrevented, 'the page must not scroll or refresh').toBe(true);
    expect(it.wheels).toEqual([]);
  });

  it('turns into the wheel for a full-screen program, and for one that asked for the mouse', () => {
    for (const [buffer, mouse] of [
      ['alternate', 'none'],
      ['normal', 'vt200'],
    ] as const) {
      const it = grid(buffer, mouse);
      touch('touchstart', 300, it.screen);
      touch('touchmove', 260, it.screen);
      it.stop();

      expect(it.wheels, `${buffer} buffer, ${mouse} mouse`).toEqual([1, 1]);
      expect(it.term.scrollLines).not.toHaveBeenCalled();
    }
  });

  it('leaves a two-finger gesture alone', () => {
    const it = grid();
    stop = it.stop;

    const two = new Event('touchstart') as TouchEvent;
    Object.defineProperty(two, 'touches', { value: [{ clientY: 1 }, { clientY: 2 }] });
    it.screen.dispatchEvent(two);
    const move = touch('touchmove', 100, it.screen);

    expect(it.term.scrollLines).not.toHaveBeenCalled();
    expect(move.defaultPrevented).toBe(false);
  });
});
