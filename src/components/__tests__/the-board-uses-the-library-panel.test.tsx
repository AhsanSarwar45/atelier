/**
 * The board's boxes are the library's box.
 *
 * A column, the outline it draws when it holds nothing and the box a comment
 * sits in each used to carry their own border, rounding and surface, which is
 * why the board never quite matched the rest of the app. They are the library's
 * <Panel> now, and a panel says so: `data-slot="panel"`. The one-library gate
 * reads the markup; this reads what renders (bw-dks8.6).
 */
import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { CommentList } from '../comment-list';
import { KanbanColumn } from '../kanban-column';
import type { Bead, Comment } from '@/types';

vi.mock('@/lib/api', () => ({ git: {} }));
vi.mock('@/lib/cli', () => ({ addComment: vi.fn() }));
vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ theme: { layout: 'standard' }, layout: 'standard', themeId: 'test' }),
}));
vi.mock('@/workbench/card-live', () => ({ CardLiveChat: () => null }));

const column = (beads: Bead[]) =>
  render(
    <KanbanColumn
      status="open"
      title="Todo"
      beads={beads}
      allBeads={beads}
      statusById={new Map()}
      onSelectBead={vi.fn()}
    />,
  ).container;

const comments: Comment[] = [
  { id: 'c1', issue_id: 'bead-1', author: 'someone', text: 'The first thing said', created_at: '2026-01-01T00:00:00Z' },
  { id: 'c2', issue_id: 'bead-1', author: 'someone else', text: 'The second', created_at: '2026-01-02T00:00:00Z' },
];

describe('the board draws its boxes with the library panel', () => {
  it('makes the column frame a panel', () => {
    const frame = column([]).querySelector('[data-column="open"]');
    expect(frame?.getAttribute('data-slot')).toBe('panel');
  });

  it('draws the empty column as a dashed panel, not a box of its own', () => {
    const container = column([]);
    // The frame is a panel too and the words are inside it, so the box being
    // looked for is the innermost one that says them.
    const empty = Array.from(container.querySelectorAll('[data-slot="panel"]')).find(
      (el) => el.textContent?.includes('No cards') && !el.querySelector('[data-slot="panel"]'),
    );
    expect(empty, 'the words a column shows when it is empty are not in a panel').toBeTruthy();
    expect(empty?.className).toContain('border-dashed');
  });

  it('puts every comment in a panel', () => {
    const { container, getByText } = render(
      <CommentList comments={comments} beadId="bead-1" projectPath="/somewhere" />,
    );
    expect(container.querySelectorAll('[data-slot="panel"]')).toHaveLength(comments.length);
    expect(getByText('The first thing said').closest('[data-slot="panel"]')).toBeTruthy();
  });
});
