/**
 * A before/after pair, side by side. Unlike a plain `images` gallery, opening
 * either picture opens BOTH in the lightbox together (`data-pair` in
 * `page.js`) — the point of a comparison is holding the two still while you
 * zoom and pan, not looking at one in isolation.
 */
import { useLightbox } from '../lightbox';
import type { CompareBlock, Shot } from '../types';

function withDefaultCaption(shot: Shot, fallback: string): Shot {
  return { ...shot, caption: shot.caption ?? fallback };
}

export function CompareBlockView({ block }: { block: CompareBlock }) {
  const { open } = useLightbox();
  const before = withDefaultCaption(block.before, 'Before');
  const after = withDefaultCaption(block.after, 'After');
  const pair = [before, after];
  const openPair = () => open(pair.map((s) => ({ src: s.src, caption: s.caption })));

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {pair.map((shot, i) => (
        <figure key={i} className="grid gap-1.5">
          {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary data: URIs from the report spec */}
          <img
            src={shot.src}
            alt={shot.caption || 'report image'}
            loading="lazy"
            className="w-full cursor-zoom-in rounded-md bg-surface-overlay"
            onClick={openPair}
          />
          <figcaption className="text-[11px] font-bold uppercase tracking-wide text-t-muted">
            {shot.caption}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
