/**
 * A column draws what the reader can see and still knows the rest.
 *
 * A column of a hundred and fifty cards put a hundred and fifty cards on the
 * screen to show five, and the browser paid for every one of them on every
 * pass. Only the handful inside the scrolling pane is drawn now — so what the
 * column holds has to be answerable without drawing it: the count in the header
 * and the list in `data-cards` are both over the whole column.
 */
import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { KanbanColumn } from '../kanban-column';
import type { Bead } from '@/types';

vi.mock('@/lib/api', () => ({ git: {} }));
vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ theme: { layout: 'standard' }, layout: 'standard', themeId: 'test' }),
}));
vi.mock('@/workbench/card-live', () => ({ CardLiveChat: () => null }));

const HELD = 150;

const cards: Bead[] = Array.from({ length: HELD }, (_, i) => ({
  id: `card-${i}`,
  title: `A piece of work ${i}`,
  status: 'open',
  priority: 1,
  issue_type: 'task',
  owner: 'someone',
  created_at: '',
  updated_at: '',
  comments: [],
}));

const draw = (beads: Bead[]) =>
  render(
    <KanbanColumn
      status="open"
      title="Todo"
      beads={beads}
      allBeads={beads}
      statusById={new Map(beads.map((b) => [b.id, b.status]))}
      onSelectBead={vi.fn()}
    />,
  ).container;

describe('a column of many cards', () => {
  it('draws far fewer cards than it holds', () => {
    const container = draw(cards);
    const drawn = container.querySelectorAll('[data-bead-id]').length;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(HELD / 4);
  });

  it('says how many it holds, not how many it drew', () => {
    const container = draw(cards);
    expect(container.querySelector('.column-count-badge')?.textContent).toBe(String(HELD));
  });

  it('names every card it holds, in order', () => {
    const container = draw(cards);
    const held = container.querySelector('[data-column="open"]')?.getAttribute('data-cards');
    expect(held?.split(' ')).toEqual(cards.map((c) => c.id));
  });

  it('draws them all when there are only a few', () => {
    const container = draw(cards.slice(0, 3));
    expect(container.querySelectorAll('[data-bead-id]')).toHaveLength(3);
  });
});
