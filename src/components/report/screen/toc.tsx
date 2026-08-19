/**
 * The report's table of contents: one entry per fixed part plus one per
 * content section, in the one order `report-document.tsx` always draws them
 * in. Clicking scrolls to that part; the current one is marked by whichever
 * part the reader has scrolled to (`use-active-section.ts`), not only by what
 * was last clicked (bw-7ks.21.4).
 *
 * Positioned by whoever mounts it — `report-tab.tsx` puts it flush against the
 * window's left edge on a wide screen, under it in the same left column in the
 * middle width, and in the top strip on a narrow one — this component only
 * draws the list, in the direction its `className` asks for.
 */
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface TocEntry {
  id: string;
  label: string;
}

export function TableOfContents({
  entries,
  activeId,
  onSelect,
  className,
}: {
  entries: TocEntry[];
  activeId: string | null;
  onSelect: (id: string) => void;
  className?: string;
}) {
  return (
    <nav aria-label="Report contents" data-testid="report-toc" className={cn('flex gap-1', className)}>
      {entries.map((entry) => (
        <Button
          key={entry.id}
          type="button"
          variant="ghost"
          size="sm"
          selected={entry.id === activeId}
          aria-current={entry.id === activeId ? 'true' : undefined}
          data-testid="report-toc-item"
          data-section-id={entry.id}
          className="shrink-0 justify-start truncate"
          onClick={() => onSelect(entry.id)}
        >
          {entry.label}
        </Button>
      ))}
    </nav>
  );
}
