'use client';

/**
 * The control that says which kinds of message a conversation draws.
 *
 * A picture on the chat's own toolbar, beside the one that opens every row. It
 * goes loud the moment anything is switched off, because a reader who has
 * forgotten he filtered a conversation is reading a conversation with holes in
 * it and no way of knowing (bw-qdim.5).
 *
 * Every line in the panel carries three things: a switch that reads on, off or
 * on-in-part, the kind's name in his words, and how many rows of THIS
 * conversation it matches — the count is what lets him see the cost of turning
 * something off before he turns it off, and what tells him a group is empty
 * here without opening it.
 */
import { useState } from 'react';

import { Check, ChevronRight, ListFilter, Minus } from 'lucide-react';

import { ToolButton } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  COMMANDS,
  flip,
  switchOf,
  treeOf,
  type KindId,
  type KindNode,
} from '@/workbench/message-filter';
import type { TranscriptItem } from '@/workbench/use-session';

interface TreeProps {
  items: TranscriptItem[];
  off: ReadonlySet<KindId>;
  onChange: (off: ReadonlySet<KindId>) => void;
}

/**
 * The tree itself. Commands arrives folded: it is the longest group and the one
 * a reader opens on purpose, and unfolded it pushes everything below it off the
 * panel.
 */
export function KindTree({ items, off, onChange }: TreeProps) {
  const [folded, setFolded] = useState<ReadonlySet<KindId>>(() => new Set([COMMANDS]));
  const fold = (id: KindId) =>
    setFolded((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const tree = treeOf(items);

  return (
    <div role="tree" aria-label="Kinds of message" data-testid="kind-tree" className="flex flex-col">
      {tree.map((node) => (
        <Line
          key={node.id}
          node={node}
          depth={0}
          off={off}
          folded={folded}
          onFold={fold}
          onFlip={(target) => onChange(flip(off, target, tree))}
        />
      ))}
    </div>
  );
}

function Line({
  node,
  depth,
  off,
  folded,
  onFold,
  onFlip,
}: {
  node: KindNode;
  depth: number;
  off: ReadonlySet<KindId>;
  folded: ReadonlySet<KindId>;
  onFold: (id: KindId) => void;
  onFlip: (node: KindNode) => void;
}) {
  const state = switchOf(node, off);
  const shut = folded.has(node.id);
  const branch = node.children.length > 0;

  return (
    <>
      <div
        role="treeitem"
        aria-expanded={branch ? !shut : undefined}
        aria-selected={state !== 'off'}
        data-testid="kind-line"
        data-kind={node.id}
        data-state={state}
        data-count={node.count}
        className="flex items-center gap-1.5 rounded px-1 py-1 text-sm hover:bg-surface-overlay"
        style={{ paddingLeft: `${depth * 1.1 + 0.25}rem` }}
      >
        {branch ? (
          <button
            type="button"
            data-testid="kind-fold"
            aria-label={shut ? `Show what is under ${node.label}` : `Fold ${node.label}`}
            onClick={() => onFold(node.id)}
            className="shrink-0 text-t-tertiary hover:text-t-primary"
          >
            <ChevronRight className={cn('size-3.5 transition-transform', !shut && 'rotate-90')} />
          </button>
        ) : (
          <span className="size-3.5 shrink-0" />
        )}

        <button
          type="button"
          data-testid="kind-switch"
          role="checkbox"
          aria-checked={state === 'half' ? 'mixed' : state === 'on'}
          aria-label={node.label}
          onClick={() => onFlip(node)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {/* An empty box is drawn in the edge the app gives a box you type
              into. The faint one is a shade off the panel behind it, which on
              a dark skin is no box at all — and a switch nobody can see is a
              switch nobody knows they can turn back on (bw-qdim.11). */}
          <span
            aria-hidden="true"
            className={cn(
              'flex size-4 shrink-0 items-center justify-center rounded-[4px] border',
              state === 'off' ? 'border-b-strong' : 'border-transparent bg-primary text-primary-foreground',
            )}
          >
            {state === 'on' && <Check className="size-3" />}
            {state === 'half' && <Minus className="size-3" />}
          </span>
          <span className={cn('truncate', state === 'off' && 'text-t-tertiary')}>{node.label}</span>
          {/* The count sits at the far end so the numbers line up and the eye
              can run down them; a kind this conversation never used says 0
              rather than hiding, which is itself the answer to "where is it?" */}
          <span data-testid="kind-count" className="ml-auto pl-2 tabular-nums text-xs text-t-tertiary">
            {node.count}
          </span>
        </button>
      </div>

      {branch &&
        !shut &&
        node.children.map((child) => (
          <Line
            key={child.id}
            node={child}
            depth={depth + 1}
            off={off}
            folded={folded}
            onFold={onFold}
            onFlip={onFlip}
          />
        ))}
    </>
  );
}

/** The toolbar button, and the panel it opens. */
export function KindFilter({ items, off, onChange }: TreeProps) {
  const filtered = off.size > 0;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <ToolButton
          icon={<ListFilter />}
          label={filtered ? 'Some kinds of message are hidden' : 'Which kinds of message show'}
          emphasis={filtered ? 'loud' : 'quiet'}
          data-testid="open-kind-filter"
          data-filtered={filtered}
        />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2" data-testid="kind-filter-panel">
        <KindTree items={items} off={off} onChange={onChange} />
        <button
          type="button"
          data-testid="show-every-kind"
          disabled={!filtered}
          onClick={() => onChange(new Set())}
          className="mt-2 w-full rounded px-1 py-1 text-left text-xs text-t-tertiary hover:bg-surface-overlay hover:text-t-primary disabled:opacity-40 disabled:hover:bg-transparent"
        >
          Show every kind
        </button>
      </PopoverContent>
    </Popover>
  );
}

/**
 * What the conversation says when the filter has left nothing standing.
 *
 * A reader who switches his last kind off is looking at an empty window, and
 * without this he has no way of telling a filtered conversation from a broken
 * one — so it says which it is, and puts everything back in one click.
 */
export function NothingShowing({ hidden, onShowAll }: { hidden: number; onShowAll: () => void }) {
  return (
    <div data-testid="nothing-showing" className="m-auto flex flex-col items-center gap-2 py-8 text-center">
      <p className="text-sm text-t-tertiary">
        {hidden === 1 ? 'The one row here is switched off.' : `All ${hidden} rows here are switched off.`}
      </p>
      <Button size="xs" variant="outline" data-testid="show-every-kind-back" onClick={onShowAll}>
        Show every kind
      </Button>
    </div>
  );
}
