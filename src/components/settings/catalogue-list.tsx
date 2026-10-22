/**
 * The scrolling list a catalogue's rows are drawn in (bw-xrffk.2).
 *
 * A marketplace can offer thousands of entries. Only the rows in view (plus a
 * few either side) are mounted, so opening the sheet and typing a search costs
 * the same whether the catalogue holds ten entries or ten thousand. Rows are
 * measured once drawn, so a row that grows (a server asking for its keys) pushes
 * the ones below it down.
 */
'use client';

import { useRef, type ReactNode } from 'react';

import { useVirtualizer } from '@tanstack/react-virtual';

import { Panel } from '@/components/ui/panel';

export function CatalogueList<T>({
  items,
  itemKey,
  render,
  estimate = 60,
  testId,
}: {
  items: readonly T[];
  itemKey: (item: T) => string;
  render: (item: T) => ReactNode;
  estimate?: number;
  testId: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => estimate,
    getItemKey: (index) => itemKey(items[index]!),
    overscan: 8,
  });

  return (
    <Panel asChild tone="frame" inset="none" className="max-h-[50vh] overflow-y-auto">
      <div ref={scroller} data-testid={`${testId}-scroller`}>
        <ul role="list" data-testid={testId} data-count={items.length} className="relative w-full" style={{ height: `${virtual.getTotalSize()}px` }}>
          {virtual.getVirtualItems().map((row) => (
            <li
              key={row.key}
              data-index={row.index}
              ref={virtual.measureElement}
              className={`absolute left-0 top-0 w-full ${row.index < items.length - 1 ? 'border-b border-border' : ''}`}
              style={{ transform: `translateY(${row.start}px)` }}
            >
              {render(items[row.index]!)}
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}
