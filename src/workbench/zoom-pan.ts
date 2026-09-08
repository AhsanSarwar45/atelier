'use client';

/**
 * The one answer to "what does a picture do under the wheel and the hand".
 *
 * Every picture surface in the app used to answer that differently — the chat's
 * viewer zoomed in half steps about the middle of the box, the Files tab had a
 * −/%/+ trio and no way to move a zoomed picture at all — so a reader met a new
 * set of rules on every screen and none of them were the rules every image
 * viewer already uses (bw-gy6z). The maths lives here once and the surfaces
 * import it, because four copies of a wheel handler is four things that drift.
 *
 * Two things make it feel right rather than merely work:
 *
 * - The zoom is about the pointer. The pixel under the cursor stays under the
 *   cursor as the scale changes. Zooming about the centre is the version that
 *   feels broken the moment somebody is looking at a detail near an edge,
 *   because the detail they are looking at is the one that runs away.
 * - The wheel listener is added by hand, not through React's `onWheel`. React
 *   attaches its wheel listener passively at the root, and a passive listener
 *   is forbidden to call `preventDefault`, so an `onWheel` handler zooms the
 *   picture AND scrolls the page behind it. `{ passive: false }` on the
 *   element itself is the only way to have one without the other.
 *
 * A trackpad pinch arrives as a wheel event with `ctrlKey` set — the browser
 * has said so since the gesture existed — so it is the same code path with a
 * larger step, which is what makes a laptop feel native.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

export interface ImageTransform {
  scale: number;
  x: number;
  y: number;
}

/** Fitted, centred, untouched — what every surface starts at and resets to. */
export const NO_TRANSFORM: ImageTransform = { scale: 1, x: 0, y: 0 };

export interface Size { width: number; height: number }

export function clampScale(scale: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, scale));
}

/**
 * How far the picture may be dragged: exactly to its own edges and no further.
 *
 * The limit is the overflow, halved, because the layer is centred — so a
 * picture that already fits cannot be moved at all (there is nothing off screen
 * to go and look at) and a zoomed one can be walked to any corner but never
 * pushed out of the room. A box we cannot measure yet — before layout, or under
 * a test renderer that reports zeros — has no limit rather than a limit of
 * zero, so nothing is silently pinned to the middle.
 */
export function panLimit(box: Size, content: Size, scale: number): Size | null {
  if (!box.width || !box.height) return null;
  return {
    width: Math.max(0, (content.width * scale - box.width) / 2),
    height: Math.max(0, (content.height * scale - box.height) / 2),
  };
}

export function clampPan(transform: ImageTransform, limit: Size | null): ImageTransform {
  if (!limit) return transform;
  const x = Math.max(-limit.width, Math.min(limit.width, transform.x));
  const y = Math.max(-limit.height, Math.min(limit.height, transform.y));
  return x === transform.x && y === transform.y ? transform : { ...transform, x, y };
}

/**
 * The new transform when the scale changes and one point must not move.
 *
 * `at` is the anchor measured from the centre of the viewport, which is where
 * a CSS transform's origin sits by default. On screen the anchor is drawn at
 * `pan + scale * p` for some point `p` of the picture; solving for `p` at the
 * old scale and putting it back at the new one gives the line below. Everything
 * else about the gesture — how big a step, where the pointer is — is somebody
 * else's problem, which is what keeps this testable.
 */
export function zoomedAbout(transform: ImageTransform, nextScale: number, at: { x: number; y: number }): ImageTransform {
  if (nextScale === transform.scale) return transform;
  const ratio = nextScale / transform.scale;
  return {
    scale: nextScale,
    x: at.x - ratio * (at.x - transform.x),
    y: at.y - ratio * (at.y - transform.y),
  };
}

/**
 * A wheel notch turned into a multiplier.
 *
 * Deltas arrive in pixels, lines or pages depending on the device and the
 * browser, so they are brought to pixels first — a mouse that reports lines
 * would otherwise move the scale by a hundredth of what a mouse that reports
 * pixels does. Exponential rather than additive, so a step in and a step back
 * out land exactly where you started and the gesture feels the same whether you
 * are at 30% or at 400%.
 */
export function wheelFactor(deltaY: number, deltaMode: number, pinch: boolean): number {
  const perLine = deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1;
  const pixels = deltaY * perLine;
  return Math.exp(-pixels * (pinch ? 0.01 : 0.0022));
}

export interface ZoomPanOptions {
  transform: ImageTransform;
  onChange: (transform: ImageTransform) => void;
  minScale: number;
  maxScale: number;
  /**
   * The picture's own unscaled size, when it is not simply the size of the
   * viewport. The chat's viewer fits its picture to the box with
   * `object-contain`, so the box IS the content; the Files tab draws a picture
   * at its real pixel size, which may be far larger.
   */
  content?: Size | null;
}

export interface ZoomPan {
  viewportRef: RefObject<HTMLDivElement>;
  /** True when there is something off screen to go and look at. */
  pannable: boolean;
  dragging: boolean;
  /** Spread onto the viewport element. */
  handlers: {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  };
  /** `grab`, `grabbing`, or nothing at all when the picture cannot move. */
  cursor: string | undefined;
  /** Scale to a value, keeping a point of the picture under a point of the box. */
  zoomTo: (scale: number, at?: { x: number; y: number } | null) => void;
}

/** Where in the box a pointer is, measured from the box's centre. */
function fromCentre(box: DOMRect, clientX: number, clientY: number) {
  return { x: clientX - (box.left + box.width / 2), y: clientY - (box.top + box.height / 2) };
}

/**
 * Whether a press belongs to a control rather than to the picture.
 *
 * A pan handler that takes every pointerdown is the usual way a change like
 * this breaks the buttons sitting on top of the picture — the press is
 * captured, the pointerup lands on the viewport instead of the button, and the
 * click never happens. Anything focusable keeps its own press.
 */
function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('button, a, input, select, textarea, [role="slider"], [data-no-pan]');
}

export function useZoomPan({ transform, onChange, minScale, maxScale, content }: ZoomPanOptions): ZoomPan {
  const viewportRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pannable, setPannable] = useState(false);

  // Read live in the wheel listener, which is attached once and must not be
  // torn down and rebuilt on every pixel of a gesture.
  const latest = useRef({ transform, onChange, minScale, maxScale, content });
  latest.current = { transform, onChange, minScale, maxScale, content };

  const limitNow = useCallback((scale: number): Size | null => {
    const node = viewportRef.current;
    if (!node) return null;
    const box = { width: node.clientWidth, height: node.clientHeight };
    const own = latest.current.content ?? box;
    return panLimit(box, own, scale);
  }, []);

  useLayoutEffect(() => {
    const limit = limitNow(transform.scale);
    setPannable(!!limit && (limit.width > 0.5 || limit.height > 0.5));
  }, [limitNow, transform.scale, transform.x, transform.y, content?.width, content?.height]);

  const zoomTo = useCallback((scale: number, at?: { x: number; y: number } | null) => {
    const { transform: was, onChange: tell, minScale: min, maxScale: max } = latest.current;
    const next = clampScale(scale, min, max);
    const moved = zoomedAbout(was, next, at ?? { x: 0, y: 0 });
    tell(clampPan(moved, limitNow(next)));
  }, [limitNow]);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      // Not passive, so this is allowed — and it is the whole point: without it
      // the page behind the picture scrolls away while the picture zooms.
      event.preventDefault();
      const { transform: was, minScale: min, maxScale: max } = latest.current;
      const next = clampScale(was.scale * wheelFactor(event.deltaY, event.deltaMode, event.ctrlKey), min, max);
      zoomTo(next, fromCentre(node.getBoundingClientRect(), event.clientX, event.clientY));
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [zoomTo]);

  const stop = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);

  return {
    viewportRef,
    pannable,
    dragging,
    cursor: dragging ? 'grabbing' : pannable ? 'grab' : undefined,
    zoomTo,
    handlers: {
      onPointerDown: (event) => {
        if (event.button !== 0 || isControl(event.target)) return;
        const limit = limitNow(transform.scale);
        if (limit && limit.width <= 0.5 && limit.height <= 0.5) return;
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: transform.x, startY: transform.y };
        setDragging(true);
        event.currentTarget.setPointerCapture?.(event.pointerId);
      },
      onPointerMove: (event) => {
        const held = drag.current;
        if (!held || held.pointerId !== event.pointerId) return;
        onChange(clampPan({
          ...transform,
          x: held.startX + event.clientX - held.x,
          y: held.startY + event.clientY - held.y,
        }, limitNow(transform.scale)));
      },
      onPointerUp: stop,
      onPointerCancel: stop,
    },
  };
}
