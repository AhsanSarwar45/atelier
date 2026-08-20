/**
 * The panel that says which kinds of message show.
 *
 * What is guarded here is what the reader sees and clicks: the button going
 * loud once anything is hidden, a group's switch carrying its children, a group
 * whose children disagree drawing half, the counts beside every line, and
 * commands arriving folded (bw-qdim.5).
 */
import { useState } from 'react';

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { KindFilter, KindTree, NothingShowing } from '@/workbench/filter-tree';
import { toolKind, type KindId } from '@/workbench/message-filter';
import type { TranscriptItem } from '@/workbench/use-session';

let next = 0;
const id = () => `i${++next}`;

const ran = (name: string): TranscriptItem => ({
  kind: 'tool',
  id: id(),
  name,
  title: name,
  status: 'ok',
  seconds: 0,
  summary: null,
  parentId: null,
  diff: null,
  input: {},
  output: null,
});

const items: TranscriptItem[] = [
  { kind: 'message', id: id(), role: 'user', text: 'go', images: [], done: true, parentId: null },
  ran('Bash'),
  ran('Read'),
  ran('Read'),
  { kind: 'message', id: id(), role: 'assistant', text: 'done', images: [], done: true, parentId: null },
];

/** The panel, holding the reader's choice the way the chat holds it. */
function Panel({ tree = false }: { tree?: boolean }) {
  const [off, setOff] = useState<ReadonlySet<KindId>>(() => new Set());
  const props = { items, off, onChange: setOff };
  // The real bar wraps every control in this the way `Toolbar` does.
  return tree ? <KindTree {...props} /> : (
    <TooltipProvider>
      <KindFilter {...props} />
    </TooltipProvider>
  );
}

const line = (kind: string) => screen.getByTestId('kind-tree').querySelector(`[data-kind="${kind}"]`)!;
const switchIn = (kind: string) => line(kind).querySelector('[data-testid="kind-switch"]')!;
const foldIn = (kind: string) => line(kind).querySelector('[data-testid="kind-fold"]')!;
const stateOf = (kind: string) => line(kind).getAttribute('data-state');

describe('the tree in the panel', () => {
  it('draws commands folded until it is clicked', () => {
    render(<Panel tree />);
    expect(line(toolKind('Bash'))).toBeNull();

    fireEvent.click(foldIn('commands'));
    expect(line(toolKind('Bash'))).not.toBeNull();
  });

  it('carries every child when a group’s switch is clicked', () => {
    render(<Panel tree />);
    fireEvent.click(foldIn('commands'));
    fireEvent.click(switchIn('commands'));

    expect(stateOf('commands')).toBe('off');
    expect(stateOf(toolKind('Bash'))).toBe('off');
    expect(stateOf(toolKind('Read'))).toBe('off');
  });

  it('draws a group half-on when its children disagree', () => {
    render(<Panel tree />);
    fireEvent.click(foldIn('commands'));
    fireEvent.click(switchIn(toolKind('Read')));

    expect(stateOf(toolKind('Read'))).toBe('off');
    expect(stateOf(toolKind('Bash'))).toBe('on');
    expect(stateOf('commands')).toBe('half');
    expect(stateOf('agent')).toBe('half');
  });

  it('gives the whole group back when it is switched on again', () => {
    render(<Panel tree />);
    fireEvent.click(foldIn('commands'));
    fireEvent.click(switchIn(toolKind('Read')));
    fireEvent.click(switchIn('commands'));
    fireEvent.click(switchIn('commands'));

    expect(stateOf(toolKind('Read'))).toBe('on');
    expect(stateOf('commands')).toBe('on');
  });

  it('says how many rows each line matches', () => {
    render(<Panel tree />);
    fireEvent.click(foldIn('commands'));

    expect(line('you').getAttribute('data-count')).toBe('1');
    expect(line(toolKind('Read')).getAttribute('data-count')).toBe('2');
    expect(line('commands').getAttribute('data-count')).toBe('3');
    expect(line('thinking').getAttribute('data-count')).toBe('0');
    expect(screen.getAllByTestId('kind-count').length).toBeGreaterThan(0);
  });
});

describe('the button on the toolbar', () => {
  it('reads quiet while every kind still shows', () => {
    render(<Panel />);
    expect(screen.getByTestId('open-kind-filter')).toHaveAttribute('data-filtered', 'false');
  });

  it('reads loud once something is hidden, and quiet again when it is all back', () => {
    render(<Panel />);
    fireEvent.click(screen.getByTestId('open-kind-filter'));
    fireEvent.click(switchIn('thinking'));
    expect(screen.getByTestId('open-kind-filter')).toHaveAttribute('data-filtered', 'true');

    fireEvent.click(screen.getByTestId('show-every-kind'));
    expect(screen.getByTestId('open-kind-filter')).toHaveAttribute('data-filtered', 'false');
  });
});

describe('when the filter has left nothing standing', () => {
  it('says the conversation is switched off rather than empty, and offers it back', () => {
    let back = 0;
    render(<NothingShowing hidden={12} onShowAll={() => (back += 1)} />);
    expect(screen.getByTestId('nothing-showing').textContent).toContain('All 12 rows here are switched off');

    fireEvent.click(screen.getByTestId('show-every-kind-back'));
    expect(back).toBe(1);
  });

  it('counts one row as one row', () => {
    render(<NothingShowing hidden={1} onShowAll={() => {}} />);
    expect(screen.getByTestId('nothing-showing').textContent).toContain('The one row here is switched off');
  });
});

describe('a switch that is off', () => {
  it('draws a box in the edge the app gives a box you type into', () => {
    render(<Panel />);
    fireEvent.click(screen.getByTestId('open-kind-filter'));
    fireEvent.click(switchIn('thinking'));

    const box = switchIn('thinking').querySelector('span')!;
    // The faint edge is a shade off the panel behind it: on the dark skins it
    // measured 1px of rgb(39,39,42) against rgb(24,24,27), which is no box.
    expect(box.className).toContain('border-b-strong');
    expect(box.className).not.toContain('border-b-default');
  });

  it('still fills the box in when it is on', () => {
    render(<Panel />);
    fireEvent.click(screen.getByTestId('open-kind-filter'));
    expect(switchIn('thinking').querySelector('span')!.className).toContain('bg-primary');
  });
});
