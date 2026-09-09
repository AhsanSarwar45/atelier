import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PictureViewer } from '@/workbench/picture-viewer';
import type { ImagePayload } from '@/workbench/protocol';
import { clampPan, panLimit, pinched, spread, wheelFactor, zoomedAbout, type ImageTransform } from '@/workbench/zoom-pan';

const image: ImagePayload = { mime: 'image/png', dataUrl: 'data:image/png;base64,picture', alt: 'A detailed picture' };

describe('zooming and panning a chat image', () => {
  it('zooms with controls, pans by dragging, and resets both', () => {
    render(<PictureViewer image={image} onClose={vi.fn()} />);
    const viewport = screen.getByTestId('picture-zoom-viewport');
    Object.assign(viewport, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByTestId('picture-transform')).toHaveAttribute('data-scale', '1.5');
    expect(screen.getByTestId('picture-zoom-level')).toHaveTextContent('150%');

    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 145, clientY: 125 });
    fireEvent.pointerUp(viewport, { pointerId: 1 });
    expect(screen.getByTestId('picture-transform')).toHaveAttribute('data-pan-x', '45');
    expect(screen.getByTestId('picture-transform')).toHaveAttribute('data-pan-y', '25');

    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom and position' }));
    expect(screen.getByTestId('picture-transform')).toHaveAttribute('data-scale', '1');
    expect(screen.getByTestId('picture-transform')).toHaveAttribute('data-pan-x', '0');
    expect(screen.getByTestId('picture-transform')).toHaveAttribute('data-pan-y', '0');
  });

  it('zooms with the wheel, out again to where it started, and back to fitted on a double click', () => {
    render(<PictureViewer image={image} onClose={vi.fn()} />);
    const viewport = screen.getByTestId('picture-zoom-viewport');
    const layer = () => screen.getByTestId('picture-transform');

    fireEvent.wheel(viewport, { deltaY: -100 });
    const zoomed = Number(layer().getAttribute('data-scale'));
    expect(zoomed).toBeGreaterThan(1.2);
    expect(screen.getByTestId('picture-zoom-level')).toHaveTextContent(`${Math.round(zoomed * 100)}%`);

    // Exponential steps, so a notch back out lands exactly where it began
    // rather than somewhere near it.
    fireEvent.wheel(viewport, { deltaY: 100 });
    expect(Number(layer().getAttribute('data-scale'))).toBeCloseTo(1, 6);

    fireEvent.wheel(viewport, { deltaY: -100 });
    fireEvent.doubleClick(viewport);
    expect(layer()).toHaveAttribute('data-scale', '1');
    expect(layer()).toHaveAttribute('data-pan-x', '0');
  });

  it('never zooms past its bounds however hard the wheel is turned', () => {
    render(<PictureViewer image={image} onClose={vi.fn()} />);
    const viewport = screen.getByTestId('picture-zoom-viewport');
    for (let i = 0; i < 40; i += 1) fireEvent.wheel(viewport, { deltaY: -100 });
    expect(screen.getByTestId('picture-transform')).toHaveAttribute('data-scale', '5');
    for (let i = 0; i < 60; i += 1) fireEvent.wheel(viewport, { deltaY: 100 });
    expect(screen.getByTestId('picture-transform')).toHaveAttribute('data-scale', '1');
  });
});

describe('the maths that keeps the pixel under the pointer', () => {
  it('leaves the anchored point exactly where it was drawn', () => {
    const at = { x: 120, y: -40 };
    const before: ImageTransform = { scale: 1.4, x: 30, y: 12 };
    const after = zoomedAbout(before, 3.2, at);
    // Where the picture-point under the anchor is drawn, before and after.
    const drawn = (t: ImageTransform) => ({
      x: t.x + t.scale * ((at.x - before.x) / before.scale),
      y: t.y + t.scale * ((at.y - before.y) / before.scale),
    });
    expect(drawn(after).x).toBeCloseTo(at.x, 9);
    expect(drawn(after).y).toBeCloseTo(at.y, 9);
    expect(after.scale).toBe(3.2);
  });

  it('zooms about the middle when that is the anchor, and reverses cleanly', () => {
    const middle = { x: 0, y: 0 };
    expect(zoomedAbout({ scale: 1, x: 0, y: 0 }, 2, middle)).toEqual({ scale: 2, x: 0, y: 0 });
    const out = zoomedAbout(zoomedAbout({ scale: 1, x: 0, y: 0 }, 2.5, { x: 60, y: 20 }), 1, { x: 60, y: 20 });
    expect(out.x).toBeCloseTo(0, 9);
    expect(out.y).toBeCloseTo(0, 9);
  });
});

describe('how far a picture may be dragged', () => {
  const box = { width: 400, height: 300 };

  it('cannot be moved at all while it fits', () => {
    const limit = panLimit(box, box, 1);
    expect(limit).toEqual({ width: 0, height: 0 });
    expect(clampPan({ scale: 1, x: 200, y: 90 }, limit)).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it('reaches its own edges once it is bigger than the box, and no further', () => {
    const limit = panLimit(box, box, 3);
    expect(limit).toEqual({ width: 400, height: 300 });
    expect(clampPan({ scale: 3, x: 999, y: -999 }, limit)).toEqual({ scale: 3, x: 400, y: -300 });
    expect(clampPan({ scale: 3, x: 120, y: -50 }, limit)).toEqual({ scale: 3, x: 120, y: -50 });
  });

  it('has no limit at all before the box has been measured, rather than a limit of zero', () => {
    expect(panLimit({ width: 0, height: 0 }, box, 4)).toBeNull();
    expect(clampPan({ scale: 4, x: 77, y: 5 }, null)).toEqual({ scale: 4, x: 77, y: 5 });
  });
});

describe('a wheel notch', () => {
  it('brings line and page deltas to the same scale as pixel ones', () => {
    expect(wheelFactor(-100, 0, false)).toBeCloseTo(wheelFactor(-100 / 16, 1, false), 9);
    expect(wheelFactor(100, 0, false)).toBeLessThan(1);
    expect(wheelFactor(-100, 0, false)).toBeGreaterThan(1);
  });

  it('steps harder for a trackpad pinch, which arrives with ctrl held', () => {
    expect(wheelFactor(-10, 0, true)).toBeGreaterThan(wheelFactor(-10, 0, false));
  });

  it('is exactly reversible', () => {
    expect(wheelFactor(-100, 0, false) * wheelFactor(100, 0, false)).toBeCloseTo(1, 9);
  });
});

describe('two fingers', () => {
  const began = (gap: number, mid = { x: 0, y: 0 }) => ({ gap, mid, transform: { scale: 1, x: 0, y: 0 } });

  it('reads a gap and a midpoint off the two of them', () => {
    expect(spread({ x: 0, y: 0 }, { x: 30, y: 40 })).toEqual({ gap: 50, mid: { x: 15, y: 20 } });
  });

  it('scales by the ratio of the gaps, however the fingers are turned', () => {
    const out = pinched(began(80), { gap: 260, mid: { x: 0, y: 0 } }, 0.25, 8);
    expect(out.scale).toBeCloseTo(3.25, 9);
  });

  it('keeps the point under the midpoint under the midpoint', () => {
    const start = { gap: 100, mid: { x: 90, y: -30 }, transform: { scale: 1.4, x: 22, y: -8 } };
    const out = pinched(start, { gap: 250, mid: start.mid }, 0.25, 8);
    // Where the picture-point under the fingers is drawn, after.
    const p = {
      x: (start.mid.x - start.transform.x) / start.transform.scale,
      y: (start.mid.y - start.transform.y) / start.transform.scale,
    };
    expect(out.x + out.scale * p.x).toBeCloseTo(start.mid.x, 9);
    expect(out.y + out.scale * p.y).toBeCloseTo(start.mid.y, 9);
  });

  it('moves the picture with the hand when the gap does not change', () => {
    const out = pinched(began(120, { x: 10, y: 10 }), { gap: 120, mid: { x: -50, y: 45 } }, 0.25, 8);
    expect(out.scale).toBe(1);
    expect(out.x).toBeCloseTo(-60, 9);
    expect(out.y).toBeCloseTo(35, 9);
  });

  /**
   * The bug this shape of the function exists to make impossible.
   *
   * A pinch arrives as two `pointermove` events per frame, one per finger, and
   * React has not re-rendered between them — so a version that folded each
   * frame into the last-rendered transform read a stale one on every second
   * event and dropped half the gesture. Because `pinched` is a pure function of
   * where the fingers started and where they are, replaying the same gesture in
   * one step or in a hundred gives the same answer.
   */
  it('lands in the same place however many frames the gesture is cut into', () => {
    const start = began(80, { x: 40, y: -20 });
    const end = { gap: 260, mid: { x: 15, y: 35 } };
    const inOneStep = pinched(start, end, 0.25, 8);
    let frames = start.transform;
    for (let i = 1; i <= 40; i += 1) {
      frames = pinched(start, {
        gap: start.gap + ((end.gap - start.gap) * i) / 40,
        mid: {
          x: start.mid.x + ((end.mid.x - start.mid.x) * i) / 40,
          y: start.mid.y + ((end.mid.y - start.mid.y) * i) / 40,
        },
      }, 0.25, 8);
    }
    expect(frames.scale).toBeCloseTo(inOneStep.scale, 9);
    expect(frames.x).toBeCloseTo(inOneStep.x, 9);
    expect(frames.y).toBeCloseTo(inOneStep.y, 9);
  });

  it('never pinches past the bounds', () => {
    expect(pinched(began(10), { gap: 4000, mid: { x: 0, y: 0 } }, 0.25, 5).scale).toBe(5);
    expect(pinched(began(4000), { gap: 1, mid: { x: 0, y: 0 } }, 0.25, 5).scale).toBe(0.25);
  });

  it('does nothing at all with no gap to divide by', () => {
    expect(pinched(began(0), { gap: 90, mid: { x: 0, y: 0 } }, 0.25, 8).scale).toBe(1);
  });
});

describe('a picture under two fingers', () => {
  it('pinches open, and the second finger does not drag it as well', () => {
    render(<PictureViewer image={image} onClose={vi.fn()} />);
    const viewport = screen.getByTestId('picture-zoom-viewport');
    Object.assign(viewport, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
    const layer = () => screen.getByTestId('picture-transform');

    // Both fingers down: whatever the first one had started is abandoned, and
    // the picture is not being dragged.
    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 160, clientY: 200 });
    fireEvent.pointerDown(viewport, { pointerId: 2, clientX: 240, clientY: 200 });
    expect(viewport).not.toHaveAttribute('data-dragging');

    // 80px apart to 240px apart, about the same midpoint: three times bigger.
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 80, clientY: 200 });
    fireEvent.pointerMove(viewport, { pointerId: 2, clientX: 320, clientY: 200 });
    expect(Number(layer().getAttribute('data-scale'))).toBeCloseTo(3, 6);

    fireEvent.pointerUp(viewport, { pointerId: 2 });
    fireEvent.pointerUp(viewport, { pointerId: 1 });
    expect(Number(layer().getAttribute('data-scale'))).toBeCloseTo(3, 6);
  });

  it('pinches a picture that fits, which cannot be dragged at all', () => {
    render(<PictureViewer image={image} onClose={vi.fn()} />);
    const viewport = screen.getByTestId('picture-zoom-viewport');
    Object.assign(viewport, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
    // jsdom lays nothing out, and an unmeasured box has no pan limit by
    // decision, so the box has to be given a size for this to be the case it
    // says it is: a picture exactly filling it, with nowhere to be dragged.
    Object.defineProperty(viewport, 'clientWidth', { value: 400, configurable: true });
    Object.defineProperty(viewport, 'clientHeight', { value: 300, configurable: true });

    // One finger on a fitted picture moves nothing — there is nowhere to go.
    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 160, clientY: 200 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 220, clientY: 260 });
    expect(screen.getByTestId('picture-transform')).toHaveAttribute('data-pan-x', '0');

    // The second finger still has to be seen, or a fitted picture could never
    // be opened up at all — which is why a pointer is recorded whether or not
    // the picture can be dragged.
    fireEvent.pointerDown(viewport, { pointerId: 2, clientX: 300, clientY: 260 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 160, clientY: 260 });
    fireEvent.pointerMove(viewport, { pointerId: 2, clientX: 400, clientY: 260 });
    expect(Number(screen.getByTestId('picture-transform').getAttribute('data-scale'))).toBeGreaterThan(1.2);
  });
});
