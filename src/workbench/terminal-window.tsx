/**
 * A window that floats over the app: a bar to drag it by, edges to pull, a
 * switch that fills the screen, and a way out.
 *
 * This is the chrome and nothing else — it takes a name and whatever should be
 * inside it, and knows nothing about what that is. What goes in is a terminal,
 * which is why the bar is the only thing you can drag by: the body will be a
 * grid of characters that wants every press and every drag for itself, and a
 * window that moved when you selected a line of output would be a window you
 * could not read from.
 *
 * It draws itself into the body of the page rather than where it was written,
 * because the shell is exactly the height of the screen and clips (see
 * `src/components/shell.tsx`), and because half the app is wrapped in things
 * that animate — a transform anywhere above this would quietly become what
 * "fixed" is measured against, and the window would end up parked inside a
 * pane instead of over the whole page. Where in the tree it is written is
 * therefore the caller's business and nothing else's — whatever draws the
 * button that opens it can hold it.
 *
 * Nothing about it survives a reload. Where a window was is worth less than it
 * costs: a remembered shape has to be checked against a screen that may be a
 * different one before it can be trusted, and a remembered shape that is wrong
 * puts the window somewhere the reader did not put it and cannot explain. The
 * card does not ask for it, and a terminal that comes back where it opens is
 * not a surprise to anybody. If a later one does ask, it belongs in local
 * storage beside the chat's panel widths, and it comes back through the same
 * clamp as everything else here.
 */
'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import { Maximize2, Minimize2, X } from 'lucide-react';
import { createPortal } from 'react-dom';

import { ToolButton } from '@/components/shell';
import { Panel } from '@/components/ui/panel';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Where the window is and how big it is, in pixels from the top left of the page. */
export type WindowRect = { x: number; y: number; width: number; height: number };

type Viewport = { width: number; height: number };

/** Which side of the window a pull is coming from; two letters is a corner. */
export type WindowEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * Small enough to tuck away, big enough to still show a line of output and to
 * leave every edge and corner a distinct thing to grab. A window dragged to
 * nothing is a window nobody can get back.
 */
export const MIN_WIDTH = 320;
export const MIN_HEIGHT = 180;

/**
 * How much of the window has to stay on the screen. The rule is the bar: all
 * of its height, and enough of its width to put a pointer on, because it is
 * the only thing the window can be moved by and it carries the fill and close
 * buttons besides. Everything else is allowed off the edge — pushing a window
 * mostly out of the way is a thing people do on purpose, and a rule that keeps
 * the whole window in view takes that away for no gain.
 */
export const KEEP_ON_SCREEN = 96;

/** The height of the bar, in pixels, so the clamp can count in the same units as the class. */
const BAR_HEIGHT = 36;

/** What each press of an arrow key is worth, matching the panel dividers in the chat. */
const STEP = 16;

/**
 * The screens the app calls narrow. This is the other side of the `sm:` classes
 * in the shell and in `src/components/ui/overlay.tsx`, which is where the same
 * decision is already made for full-page panels: below it, the screen is the
 * panel. Asked as a media query rather than measured off `innerWidth` so that
 * it is the same evaluator answering as the one behind those classes, and the
 * two can never disagree by a pixel at the boundary.
 */
const PHONE = '(max-width: 639px)';

const viewportNow = (): Viewport =>
  typeof window === 'undefined'
    ? { width: MIN_WIDTH, height: MIN_HEIGHT }
    : { width: window.innerWidth, height: window.innerHeight };

/**
 * Where a window sits when it is first opened: wide, short, and against the
 * bottom of the screen, which is where a terminal has always lived and which
 * keeps it out of the way of the two bars at the top.
 */
export function openingRect(view: Viewport): WindowRect {
  const margin = 24;
  const width = Math.max(MIN_WIDTH, Math.min(760, view.width - margin * 2));
  const height = Math.max(MIN_HEIGHT, Math.min(420, view.height - margin * 2));
  return { x: Math.round((view.width - width) / 2), y: view.height - height - margin, width, height };
}

/**
 * The window, pulled back until the rule above holds.
 *
 * Applied after every drag and again whenever the browser window changes size,
 * so a window left near an edge on a wide screen is still reachable when the
 * same page is opened narrower — the alternative is a window that is somewhere
 * off to the right of a laptop screen with nothing to grab and no way to know
 * it is even open.
 */
export function clampToViewport(rect: WindowRect, view: Viewport): WindowRect {
  const width = Math.min(Math.max(rect.width, MIN_WIDTH), Math.max(view.width, MIN_WIDTH));
  const height = Math.min(Math.max(rect.height, MIN_HEIGHT), Math.max(view.height, MIN_HEIGHT));
  return {
    width: Math.round(width),
    height: Math.round(height),
    x: Math.round(Math.min(Math.max(rect.x, KEEP_ON_SCREEN - width), Math.max(view.width - KEEP_ON_SCREEN, 0))),
    y: Math.round(Math.min(Math.max(rect.y, 0), Math.max(view.height - BAR_HEIGHT, 0))),
  };
}

/**
 * The window as it is after an edge has been pulled by some distance.
 *
 * The far edge does not move: pulling the left edge to the right takes width
 * off and puts the same amount onto x, and when the window will not shrink any
 * further the left edge stops rather than pushing the right one along with it.
 */
export function resizedBy(start: WindowRect, edge: WindowEdge, dx: number, dy: number): WindowRect {
  const next = { ...start };
  if (edge.includes('e')) next.width = Math.max(MIN_WIDTH, start.width + dx);
  if (edge.includes('s')) next.height = Math.max(MIN_HEIGHT, start.height + dy);
  if (edge.includes('w')) {
    next.width = Math.max(MIN_WIDTH, start.width - dx);
    next.x = start.x + start.width - next.width;
  }
  if (edge.includes('n')) {
    next.height = Math.max(MIN_HEIGHT, start.height - dy);
    next.y = start.y + start.height - next.height;
  }
  return next;
}

/** Is this one of the narrow screens where the window does not float at all? */
function usePhoneScreen(): boolean {
  const [phone, setPhone] = useState(
    () => typeof window !== 'undefined' && (window.matchMedia?.(PHONE)?.matches ?? false),
  );
  useEffect(() => {
    const query = window.matchMedia?.(PHONE);
    if (!query) return;
    const answer = () => setPhone(query.matches);
    answer();
    query.addEventListener('change', answer);
    return () => query.removeEventListener('change', answer);
  }, []);
  return phone;
}

/** An edge or a corner: what it is called, where it is drawn, and how it is grabbed. */
const HANDLES: { edge: WindowEdge; name: string; orientation: 'horizontal' | 'vertical'; className: string }[] = [
  { edge: 'n', name: 'top edge', orientation: 'horizontal', className: 'inset-x-4 -top-1 h-2 cursor-ns-resize' },
  { edge: 's', name: 'bottom edge', orientation: 'horizontal', className: 'inset-x-4 -bottom-1 h-2 cursor-ns-resize' },
  { edge: 'w', name: 'left edge', orientation: 'vertical', className: 'inset-y-4 -left-1 w-2 cursor-ew-resize' },
  { edge: 'e', name: 'right edge', orientation: 'vertical', className: 'inset-y-4 -right-1 w-2 cursor-ew-resize' },
  { edge: 'nw', name: 'top left corner', orientation: 'vertical', className: '-left-1 -top-1 size-4 cursor-nwse-resize' },
  { edge: 'ne', name: 'top right corner', orientation: 'vertical', className: '-right-1 -top-1 size-4 cursor-nesw-resize' },
  { edge: 'sw', name: 'bottom left corner', orientation: 'vertical', className: '-bottom-1 -left-1 size-4 cursor-nesw-resize' },
  { edge: 'se', name: 'bottom right corner', orientation: 'vertical', className: '-bottom-1 -right-1 size-4 cursor-nwse-resize' },
];

/** A corner is for pointers only; see the note where the handles are drawn. */
const isCorner = (edge: WindowEdge) => edge.length === 2;

export function TerminalWindow({
  title,
  onClose,
  className,
  children,
}: {
  /** What the window is, shown in its bar and heard by a screen reader. */
  title: string;
  /** The way out. Required: a window with no way to shut it is a window that owns the screen. */
  onClose: () => void;
  /** Anything the caller needs on the window itself; the geometry is not negotiable. */
  className?: string;
  children: ReactNode;
}) {
  const phone = usePhoneScreen();
  const [rect, setRect] = useState<WindowRect>(() => clampToViewport(openingRect(viewportNow()), viewportNow()));
  /**
   * The shape to come back to, and the only record that the window is filled.
   * One piece of state rather than two, so "filled" and "what it was before"
   * cannot drift apart — the bug this card names is a window that comes back to
   * a default, and the way that happens is a boolean whose partner was never
   * written or was written from the wrong place.
   */
  const [remembered, setRemembered] = useState<WindowRect | null>(null);
  const filled = remembered !== null;
  const [gesturing, setGesturing] = useState(false);
  const gesture = useRef<{
    edge: WindowEdge | null;
    from: { x: number; y: number };
    start: WindowRect;
    handle: HTMLElement;
    pointerId: number;
  } | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);

  // Nothing is drawn until the page is real. The window lives in the body, and
  // the body is not there when Next renders this on the server; deciding that
  // once here means the first client render agrees with the server's empty one
  // and there is nothing to mismatch.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  // The window is what the reader just asked for, so the keys go to it — but
  // only if whatever is inside has not already claimed them, which is what a
  // terminal does the moment it mounts.
  useEffect(() => {
    const box = panel.current;
    if (!box || box.contains(document.activeElement)) return;
    box.focus({ preventScroll: true });
  }, [ready]);

  const settle = useCallback((next: WindowRect) => setRect(clampToViewport(next, viewportNow())), []);

  // A filled window is the screen, so it grows and shrinks with it; a floating
  // one only has to still be reachable.
  useEffect(() => {
    const onResize = () => {
      const view = viewportNow();
      setRect((current) =>
        filled ? { x: 0, y: 0, width: view.width, height: view.height } : clampToViewport(current, view),
      );
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [filled]);

  /**
   * Escape while something is being dragged puts the window back where the drag
   * started, and Escape at any other time does nothing at all — this listener
   * only exists while a pointer is down.
   *
   * That silence is the decision. The body of this window is a terminal, and
   * Escape belongs to whatever is running in it: to close on Escape is to shut
   * the window every time somebody leaves insert mode. The way out is the cross
   * in the bar, which is a thing you can see.
   */
  useEffect(() => {
    if (!gesturing) return;
    const abandon = (event: globalThis.KeyboardEvent) => {
      const running = gesture.current;
      if (event.key !== 'Escape' || !running) return;
      event.preventDefault();
      event.stopPropagation();
      setRect(running.start);
      running.handle.releasePointerCapture?.(running.pointerId);
      gesture.current = null;
      setGesturing(false);
    };
    window.addEventListener('keydown', abandon, true);
    return () => window.removeEventListener('keydown', abandon, true);
  }, [gesturing]);

  const toggleFill = useCallback(() => {
    const view = viewportNow();
    if (remembered) {
      setRect(clampToViewport(remembered, view));
      setRemembered(null);
      return;
    }
    setRemembered(rect);
    setRect({ x: 0, y: 0, width: view.width, height: view.height });
  }, [remembered, rect]);

  const grab = (edge: WindowEdge | null) => (event: ReactPointerEvent<HTMLElement>) => {
    // Left button only, and nothing prevented: a `preventDefault` here would
    // also stop the press putting focus on what was pressed, and the bar and
    // the edges are the same things the arrow keys work on afterwards. Nothing
    // is selected by the drag because the bar says so in its classes, not
    // because the press was swallowed.
    if (event.button !== 0) return;
    gesture.current = {
      edge,
      from: { x: event.clientX, y: event.clientY },
      start: rect,
      handle: event.currentTarget,
      pointerId: event.pointerId,
    };
    setGesturing(true);
    // Captured, so the window keeps following a pointer that has run off the
    // edge of it — a drag is thrown, not traced, and without this the window is
    // dropped the moment the pointer outruns it.
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const drag = (event: ReactPointerEvent<HTMLElement>) => {
    const running = gesture.current;
    if (!running) return;
    const dx = event.clientX - running.from.x;
    const dy = event.clientY - running.from.y;
    settle(
      running.edge
        ? resizedBy(running.start, running.edge, dx, dy)
        : { ...running.start, x: running.start.x + dx, y: running.start.y + dy },
    );
  };

  const letGo = (event: ReactPointerEvent<HTMLElement>) => {
    if (!gesture.current) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    gesture.current = null;
    setGesturing(false);
  };

  const arrow = (event: ReactKeyboardEvent<HTMLElement>, edge: WindowEdge | null) => {
    const step: Record<string, { dx: number; dy: number }> = {
      ArrowLeft: { dx: -STEP, dy: 0 },
      ArrowRight: { dx: STEP, dy: 0 },
      ArrowUp: { dx: 0, dy: -STEP },
      ArrowDown: { dx: 0, dy: STEP },
    };
    const moved = step[event.key];
    if (!moved) return;
    // An edge only answers to the arrows along its own axis; the ones across it
    // would be asking it to move rather than to stretch.
    const sideways = edge === 'n' || edge === 's';
    const upright = edge === 'e' || edge === 'w';
    if ((sideways && moved.dx) || (upright && moved.dy)) return;
    event.preventDefault();
    settle(
      edge
        ? resizedBy(rect, edge, moved.dx, moved.dy)
        : { ...rect, x: rect.x + moved.dx, y: rect.y + moved.dy },
    );
  };

  if (!ready) return null;

  // A filled window has nowhere to be dragged to and no edge outside the screen
  // to pull, and a phone is a filled window that never had the choice. In both
  // cases the handles are not drawn at all rather than drawn and ignored: a
  // grab handle that does nothing is a promise the window does not keep.
  const movable = !phone && !filled;

  const handle = movable
    ? ({
        role: 'button',
        tabIndex: 0,
        'aria-label': `Move ${title}`,
        'data-testid': 'terminal-window-handle',
        onPointerDown: grab(null),
        onPointerMove: drag,
        onPointerUp: letGo,
        onPointerCancel: letGo,
        onDoubleClick: toggleFill,
        onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleFill();
            return;
          }
          arrow(event, null);
        },
      } as const)
    : null;

  return createPortal(
    <TooltipProvider delayDuration={250}>
      {/* The face is the library's — an overlay panel is exactly this: opaque,
          and lifted off what it covers. What is added here is where it sits and
          how far off the page it is lifted, and on a phone the corners and the
          border go, because there is nothing beside it for them to separate it
          from. Deeper shadow than the library's inline panels: this one is over
          the whole app rather than inside a pane of it. */}
      <Panel
        asChild
        tone="overlay"
        inset="none"
        className={cn(
          'fixed z-40 flex flex-col shadow-2xl outline-none',
          // Written apart from `fixed` on purpose: `fixed inset-0` on a painted
          // box is how the house check spells "a backdrop drawn by hand", and
          // this is a window, not a backdrop.
          phone && 'inset-0 rounded-none border-0',
          className,
        )}
      >
        <div
          ref={panel}
          // A window, not a modal: the page behind it stays live and stays
          // readable, which is the whole point of a terminal you can put beside
          // your work.
          role="dialog"
          aria-modal="false"
          aria-label={title}
          data-testid="terminal-window"
          data-filled={filled ? 'true' : undefined}
          tabIndex={-1}
          style={phone ? undefined : { left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        >
          <div
            className={cn(
              'flex h-9 shrink-0 select-none items-center gap-1 border-b border-border/40 bg-surface-overlay px-2',
              phone ? 'rounded-none' : 'rounded-t-md',
              movable && 'cursor-move touch-none',
            )}
            {...handle}
          >
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-t-secondary">{title}</span>
            {!phone && (
              <ToolButton
                icon={filled ? <Minimize2 /> : <Maximize2 />}
                label={filled ? `Put ${title} back` : `Fill the screen with ${title}`}
                onClick={toggleFill}
                data-testid="terminal-window-fill"
              />
            )}
            <ToolButton icon={<X />} label={`Close ${title}`} onClick={onClose} data-testid="terminal-window-close" />
          </div>
          <div data-testid="terminal-window-body" className="min-h-0 flex-1 overflow-hidden rounded-b-md">
            {children}
          </div>
          {movable &&
            HANDLES.map(({ edge, name, orientation, className: where }) => (
              <div
                key={edge}
                // The four edges are the keyboard's way in; the corners are not.
                // A corner does nothing an edge cannot do twice, and eight tab
                // stops around one window is a tab key that never gets past it.
                {...(isCorner(edge)
                  ? { 'aria-hidden': true }
                  : {
                      role: 'separator',
                      tabIndex: 0,
                      'aria-label': `Resize ${title} from the ${name}`,
                      'aria-orientation': orientation,
                      'aria-valuemin': orientation === 'vertical' ? MIN_WIDTH : MIN_HEIGHT,
                      'aria-valuemax': orientation === 'vertical' ? viewportNow().width : viewportNow().height,
                      'aria-valuenow': Math.round(orientation === 'vertical' ? rect.width : rect.height),
                      onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => arrow(event, edge),
                    })}
                data-testid={`terminal-window-resize-${edge}`}
                className={cn('absolute touch-none focus-visible:outline-none', where)}
                onPointerDown={grab(edge)}
                onPointerMove={drag}
                onPointerUp={letGo}
                onPointerCancel={letGo}
              />
            ))}
        </div>
      </Panel>
    </TooltipProvider>,
    document.body,
  );
}
