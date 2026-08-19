/** A gallery of screenshots. Two shots sit side by side; any other count stacks. Every picture opens in the shared lightbox. */
import { useLightbox } from '../lightbox';
import type { ImagesBlock } from '../types';

export function ImagesBlockView({ block }: { block: ImagesBlock }) {
  const { open } = useLightbox();
  const twoUp = block.shots.length === 2;

  return (
    <div className={`grid gap-3 ${twoUp ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
      {block.shots.map((shot, i) => (
        <figure key={i} className="grid grid-cols-1 gap-1.5">
          {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary data: URIs from the report spec */}
          <img
            src={shot.src}
            alt={shot.caption || 'report image'}
            loading="lazy"
            className="w-full cursor-zoom-in rounded-md bg-surface-overlay"
            onClick={() => open([{ src: shot.src, caption: shot.caption }])}
          />
          {shot.caption && (
            <figcaption className="text-[11px] font-bold uppercase tracking-wide text-t-muted">
              {shot.caption}
            </figcaption>
          )}
        </figure>
      ))}
    </div>
  );
}
