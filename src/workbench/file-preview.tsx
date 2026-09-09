'use client';

/**
 * A file that is not text, shown as the thing it is (bw-g3o3.14).
 *
 * A picture opened as a wall of bytes, or a video opened as nothing at all, is
 * the moment a reader gives up on the Files tab and reaches for a file manager.
 * So the kind decides the view: a picture on a checkerboard with its real pixel
 * size and a zoom, a video and a sound in the elements the browser already
 * knows how to scrub, a PDF in a frame, and SVG and Markdown in whichever of
 * the two ways the reader wants them — because both are files you sometimes
 * need to read and sometimes need to edit.
 *
 * The kinds themselves come from `file-kinds.ts`, the one table the badges and
 * the tree already share. Only the handful of extensions whose *view* differs
 * from their badge — an SVG is a picture but also source, a PDF and a Markdown
 * file are both filed under text — are named here.
 *
 * The bytes come from `/api/fs/media`, which answers Range requests with a 206
 * (bw-g3o3.2). That is not a detail: without it a browser cannot seek, and a
 * two-hour screen recording can only be watched from the beginning.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { Minus, Plus } from 'lucide-react';

import { fileKind } from '@/components/file-kinds';
import { MarkdownBody } from '@/components/markdown-body';
import { Button } from '@/components/ui/button';
import { apiUrl } from '@/lib/api-base';
import { cn } from '@/lib/utils';
import { CodeEditor } from '@/workbench/code-editor';
import { NO_TRANSFORM, clampScale, useZoomPan, type ImageTransform } from '@/workbench/zoom-pan';

/**
 * How a file is shown, which is not quite what kind of file it is. `text` means
 * the CodeMirror viewer, and is the answer for everything with no view of its
 * own — including a binary nobody has a preview for, which the viewer already
 * reports by name and size.
 */
export type PreviewKind = 'image' | 'svg' | 'video' | 'audio' | 'pdf' | 'markdown' | 'text';

/** The kinds that need the file's text as well as its bytes. */
export const PREVIEWS_NEEDING_TEXT: PreviewKind[] = ['svg', 'markdown', 'text'];

export function previewKind(path: string): PreviewKind {
  const extension = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  // The three exceptions to the badge table, each for the same reason: what a
  // file IS and how it is best read are not always the same answer.
  if (extension === 'svg') return 'svg';
  if (extension === 'pdf') return 'pdf';
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  switch (fileKind(path)) {
    case 'image': return 'image';
    case 'video': return 'video';
    case 'audio': return 'audio';
    default: return 'text';
  }
}

/**
 * The folder a file sits in — what a link written inside it is relative to. A
 * file at the very root of the machine is its own folder (bw-ewem.1).
 */
function folderOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}

/** Where the bytes of a file on this machine are served from. */
export function mediaUrl(path: string): string {
  return apiUrl(`/api/fs/media?path=${encodeURIComponent(path)}`);
}

/**
 * The light and dark squares behind a picture, so a transparent PNG reads as
 * transparent rather than as whatever colour the app happens to be wearing.
 */
const CHECKERBOARD = {
  backgroundImage:
    'linear-gradient(45deg, rgba(128,128,128,.22) 25%, transparent 25%),'
    + 'linear-gradient(-45deg, rgba(128,128,128,.22) 25%, transparent 25%),'
    + 'linear-gradient(45deg, transparent 75%, rgba(128,128,128,.22) 75%),'
    + 'linear-gradient(-45deg, transparent 75%, rgba(128,128,128,.22) 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
};

const ZOOMS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8];
/** The wheel is continuous, so it is bounded by the ends of that ladder. */
const MIN_ZOOM = ZOOMS[0];
const MAX_ZOOM = ZOOMS[ZOOMS.length - 1];

function Bar({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="file-preview-bar"
      className="flex shrink-0 items-center gap-2 border-b border-b-default bg-surface-raised/40 px-3 py-1 text-[11px] text-t-muted"
    >
      {children}
    </div>
  );
}

/** The Source / Preview switch, for the kinds that are legibly both. */
function SourceSwitch({ showing, onChange }: { showing: 'source' | 'preview'; onChange: (next: 'source' | 'preview') => void }) {
  return (
    <div data-testid="file-preview-switch" className="flex items-center gap-0.5">
      {(['preview', 'source'] as const).map((which) => (
        <Button
          key={which}
          type="button"
          size="xs"
          variant={showing === which ? 'secondary' : 'ghost'}
          data-testid={`file-preview-${which}`}
          aria-pressed={showing === which}
          className="h-5 px-2 capitalize"
          onClick={() => onChange(which)}
        >
          {which}
        </Button>
      ))}
    </div>
  );
}

/**
 * A picture at its real pixel size, zoomed and moved the way any image viewer
 * does it: the wheel scales about the pointer and the hand drags it around.
 *
 * Every picture the app draws comes through here — a raster one and an SVG
 * alike. The SVG used to have a stage of its own a few lines below, a plain
 * `<img>` in an `overflow-auto` box, which meant an SVG could not be zoomed by
 * ANY pointer while the PNG beside it zoomed under the wheel. Nothing caught
 * it because that second stage answered to the same `data-testid` as this one,
 * so a spec asking for the stage got whichever one the file kind happened to
 * render (bw-e3dw.15). There is one stage now, and the case beside this file
 * fails a second source file that draws another under this name.
 *
 * It used to be a −/%/+ trio over a scrolling box and nothing else, so a
 * zoomed-in picture was a picture you could not look around — the reader who
 * asked for this had just met that in the Files tab (bw-gy6z). The gesture is
 * `useZoomPan`, the same one the chat's picture viewer uses, so it is one
 * behaviour rather than two that drift.
 *
 * The buttons still step through the ladder of round percentages a person
 * actually asks for, and the percentage itself is still the button that puts
 * the picture back — now returning the position along with the scale, because
 * a reset that leaves the picture off in a corner has not reset anything.
 */
function ImagePreview({ path, swap }: { path: string; swap?: ReactNode }) {
  const [shape, setShape] = useState<{ width: number; height: number } | null>(null);
  const [transform, setTransform] = useState<ImageTransform>(NO_TRANSFORM);
  // A new file is a new picture: its size is not known again until it loads,
  // and a zoom carried over from the last one is a reader's setting applied to
  // something they never chose it for.
  useEffect(() => {
    setShape(null);
    setTransform(NO_TRANSFORM);
  }, [path]);

  const zoom = transform.scale;
  const { viewportRef, handlers, cursor, pannable, dragging, zoomTo } = useZoomPan({
    transform,
    onChange: setTransform,
    minScale: MIN_ZOOM,
    maxScale: MAX_ZOOM,
    content: shape,
  });

  const step = (by: number) => {
    const at = ZOOMS.findIndex((one) => one >= zoom - 0.001);
    const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (at === -1 ? ZOOMS.length - 1 : at) + by))] ?? zoom;
    zoomTo(clampScale(next, MIN_ZOOM, MAX_ZOOM));
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Bar>
        <span data-testid="file-preview-dimensions" className="tabular-nums">
          {shape ? `${shape.width} × ${shape.height}` : 'Loading…'}
        </span>
        <span className="flex-1" />
        <div data-testid="file-preview-zoom" className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" className="h-5 w-5" aria-label="Zoom out" onClick={() => step(-1)}>
            <Minus className="h-3 w-3" />
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            data-testid="file-preview-zoom-level"
            className="h-5 min-w-[3.5rem] px-1 text-[11px] tabular-nums"
            aria-label="Reset zoom and position"
            onClick={() => setTransform(NO_TRANSFORM)}
          >
            {Math.round(zoom * 100)}%
          </Button>
          <Button type="button" variant="ghost" size="icon" className="h-5 w-5" aria-label="Zoom in" onClick={() => step(1)}>
            <Plus className="h-3 w-3" />
          </Button>
        </div>
        {/* An SVG reads as source too, and its switch belongs on the bar it
            already has rather than on a second one stacked above it. */}
        {swap}
      </Bar>
      <div
        ref={viewportRef}
        data-testid="file-preview-image-stage"
        data-scale={zoom}
        data-pan-x={transform.x}
        data-pan-y={transform.y}
        data-pannable={pannable || undefined}
        data-dragging={dragging || undefined}
        className="relative min-h-0 min-w-0 flex-1 touch-none overflow-hidden"
        style={{ ...CHECKERBOARD, cursor }}
        {...handlers}
      >
        <div
          data-testid="file-preview-image-transform"
          className="absolute inset-0 flex items-center justify-center"
          style={{ transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${zoom})` }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            data-testid="file-preview-image"
            src={mediaUrl(path)}
            alt={path}
            // Its own pixels at 100%, so a 32-pixel icon is not blown up to fill
            // the room and called a preview. The zoom is the layer's transform
            // rather than a width, so scaling and moving are one gesture.
            style={shape ? { width: shape.width, height: shape.height, maxWidth: 'none' } : undefined}
            className="max-w-none shrink-0 select-none"
            draggable={false}
            onLoad={(event) => {
              const img = event.currentTarget;
              setShape({ width: img.naturalWidth, height: img.naturalHeight });
            }}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The kinds that are legibly a picture AND legibly source, with the switch
 * between the two.
 *
 * The switch is handed to the preview rather than drawn above it, because a
 * preview may already have a bar of its own — an SVG's is the picture's
 * dimensions and its zoom — and two bars stacked is 44px of chrome on a 390px
 * screen saying less than one bar would (bw-e3dw.15). The source view has no
 * bar of its own, so this draws it one.
 */
function TwoWays({ path, text, preview }: { path: string; text: string; preview: (swap: ReactNode) => ReactNode }) {
  const [showing, setShowing] = useState<'source' | 'preview'>('preview');
  useEffect(() => setShowing('preview'), [path]);
  const swap = <SourceSwitch showing={showing} onChange={setShowing} />;
  if (showing === 'preview') return <>{preview(swap)}</>;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Bar>
        <span className="flex-1" />
        {swap}
      </Bar>
      <div data-testid="file-preview-source-view" className="min-h-0 flex-1">
        <CodeEditor text={text} path={path} className="h-full" />
      </div>
    </div>
  );
}

export interface FilePreviewProps {
  /** The absolute path of the file on the machine. */
  path: string;
  kind: PreviewKind;
  /** The file's text, for the kinds that read as source too. */
  text?: string;
  className?: string;
}

export function FilePreview({ path, kind, text = '', className }: FilePreviewProps) {
  const src = mediaUrl(path);
  return (
    <div data-testid="file-preview" data-kind={kind} className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)}>
      {kind === 'image' ? (
        <ImagePreview path={path} />
      ) : kind === 'video' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-black/40 p-4">
          {/* Controls, and nothing preloaded past the first frames: the route
              answers ranges, so the browser fetches what is being watched. */}
          <video
            data-testid="file-preview-video"
            src={src}
            controls
            preload="metadata"
            className="max-h-full max-w-full"
          />
        </div>
      ) : kind === 'audio' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <audio data-testid="file-preview-audio" src={src} controls className="w-full max-w-lg" />
        </div>
      ) : kind === 'pdf' ? (
        <iframe data-testid="file-preview-pdf" src={src} title={path} className="min-h-0 flex-1 border-0 bg-white" />
      ) : kind === 'svg' ? (
        /* The same stage as a PNG, and for the same reason the wheel and the
           hand live in one hook: an SVG is a picture, and a reader who has just
           zoomed into one file should not find the next one frozen because it
           happened to be drawn by a different branch (bw-e3dw.15). */
        <TwoWays path={path} text={text} preview={(swap) => <ImagePreview path={path} swap={swap} />} />
      ) : (
        <TwoWays
          path={path}
          text={text}
          preview={(swap) => (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <Bar>
                <span className="flex-1" />
                {swap}
              </Bar>
              <div data-testid="file-preview-markdown" className="min-h-0 flex-1 overflow-auto p-6">
                {/* The file's own folder goes with its words, so `./notes.md`
                    and `../src/a.ts` name the files a reader of this file on
                    disk would find at those addresses (bw-ewem.1). */}
                <MarkdownBody base={folderOf(path)}>{text}</MarkdownBody>
              </div>
            </div>
          )}
        />
      )}
    </div>
  );
}
