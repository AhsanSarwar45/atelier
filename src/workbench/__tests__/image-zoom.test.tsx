import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PictureViewer } from '@/workbench/picture-viewer';
import type { ImagePayload } from '@/workbench/protocol';
import { clampPan, panLimit, wheelFactor, zoomedAbout, type ImageTransform } from '@/workbench/zoom-pan';

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
