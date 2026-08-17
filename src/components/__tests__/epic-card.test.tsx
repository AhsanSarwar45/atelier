/**
 * Which column offers the button that finishes a job.
 *
 * Manager Review is the one column no session may move a card out of
 * (corsetta `scripts/hooks/board-status-gate.py`, which tells a session the
 * manager signs it on his own screen), so the screen is the only place a job
 * there can be finished. Agent Review must offer nothing: a job waiting to be
 * read has been signed by nobody yet, and a finish offered there is how
 * unsigned work reached Done.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { EpicCard } from '../epic-card';
import type { CardLayout } from '@/lib/themes';
import type { Bead, BeadStatus, Epic } from '@/types';

vi.mock('@/lib/cli', () => ({ closeBead: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/api', () => ({ git: { prStatus: vi.fn().mockResolvedValue({ pr: null }) } }));

/** The layout the card is drawn in, so every theme's shape can be read. */
let layout: CardLayout = 'standard';
vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ theme: { layout }, layout, themeId: 'test' }),
}));

/** Every shape a card is drawn in — one per group of themes. */
const LAYOUTS: CardLayout[] = ['standard', 'compact-row', 'property-tags'];

beforeEach(() => {
  layout = 'standard';
  vi.clearAllMocks();
});

const FINISH = /mark done/i;

const child: Bead = {
  id: 'test-1.1', title: 'A piece of it', status: 'closed', priority: 0,
  issue_type: 'task', owner: 'someone', created_at: '', updated_at: '', comments: [],
};

const epicIn = (status: BeadStatus): Epic => ({
  id: 'test-1', title: 'A job', status, priority: 0,
  issue_type: 'epic', owner: 'someone', created_at: '', updated_at: '', comments: [],
  children: [child.id],
});

const draw = (status: BeadStatus) =>
  render(
    <EpicCard
      epic={epicIn(status)}
      allBeads={[child]}
      onSelect={vi.fn()}
      onChildClick={vi.fn()}
      projectPath="/test/project"
    />
  );

/** A job of `done` finished pieces and `dropped` dropped ones, and nothing else. */
const withPieces = (status: BeadStatus, done: number, dropped: number) => {
  const pieces: Bead[] = [
    ...Array.from({ length: done }, (_, i) => ({
      ...child, id: `test-1.d${i}`, status: 'closed' as BeadStatus,
    })),
    ...Array.from({ length: dropped }, (_, i) => ({
      ...child, id: `test-1.x${i}`, status: 'cancelled' as BeadStatus,
    })),
  ];
  return {
    epic: { ...epicIn(status), children: pieces.map((p) => p.id) },
    allBeads: pieces,
    onSelect: vi.fn(),
    onChildClick: vi.fn(),
    projectPath: '/test/project',
  };
};

describe('the button that finishes a job', () => {
  it('is drawn on a job waiting for the manager', () => {
    draw('manager_review');
    expect(screen.getByRole('button', { name: FINISH })).toBeInTheDocument();
  });

  it('is not drawn on a job still waiting to be read', () => {
    draw('inreview');
    expect(screen.queryByRole('button', { name: FINISH })).toBeNull();
  });

  it('is not drawn on a job nobody has started', () => {
    draw('open');
    expect(screen.queryByRole('button', { name: FINISH })).toBeNull();
  });

  it('is not drawn while a piece of the job is still open', () => {
    const unfinished: Bead = { ...child, id: 'test-1.2', status: 'in_progress' };
    render(
      <EpicCard
        epic={{ ...epicIn('manager_review'), children: [child.id, unfinished.id] }}
        allBeads={[child, unfinished]}
        onSelect={vi.fn()}
        onChildClick={vi.fn()}
        projectPath="/test/project"
      />
    );
    expect(screen.queryByRole('button', { name: FINISH })).toBeNull();
  });

  it('is not drawn on a job whose every piece was dropped', () => {
    // Nothing was finished there, so it is a job to drop, not one to sign off.
    render(<EpicCard {...withPieces('manager_review', 0, 3)} />);
    expect(screen.queryByRole('button', { name: FINISH })).toBeNull();
  });

  it('is drawn when every piece left is finished and the rest were dropped', () => {
    // bw-oio5's shape: ten finished, four dropped, none standing. Counting the
    // dropped ones in the total held it at 71%, and the button never appeared.
    render(<EpicCard {...withPieces('manager_review', 10, 4)} />);
    expect(screen.getByRole('button', { name: FINISH })).toBeInTheDocument();
  });
});

describe('what a card says it is made of', () => {
  it('counts only the pieces still part of the job', () => {
    render(<EpicCard {...withPieces('manager_review', 10, 4)} />);
    expect(screen.getByText(/10\/10/)).toBeInTheDocument();
    expect(screen.getAllByText('100%').length).toBeGreaterThan(0);
  });

  it('says how many of its pieces were dropped', () => {
    render(<EpicCard {...withPieces('manager_review', 10, 4)} />);
    expect(screen.getAllByText(/4 dropped/).length).toBeGreaterThan(0);
  });

  it('says nothing about dropped work when none was dropped', () => {
    render(<EpicCard {...withPieces('open', 2, 0)} />);
    expect(screen.queryByText(/dropped/)).toBeNull();
  });

  it.each(LAYOUTS)('says how much it dropped in the %s shape too', (shape) => {
    // Three of the eleven themes draw the shared shape, which carried a full
    // bar over a piece count that still included the dropped work.
    layout = shape;
    const { container } = render(<EpicCard {...withPieces('manager_review', 10, 4)} />);
    expect(screen.getAllByText(/4 dropped/).length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/\b14\b/);
  });

  it.each(LAYOUTS)('says what stands behind the numbers in the %s shape too', (shape) => {
    // The default shape kept its own copy of this block and was the only one
    // saying any of it; a reader was told different things by different themes.
    layout = shape;
    const props = withPieces('open', 1, 1);
    const live: Bead = { ...child, id: 'test-1.live', status: 'in_progress' };
    render(
      <EpicCard
        {...props}
        epic={{ ...props.epic, children: [...props.epic.children, live.id] }}
        allBeads={[...props.allBeads, live]}
      />
    );
    expect(screen.getByText(/1 in progress/)).toBeInTheDocument();
    expect(screen.getAllByText(/1 dropped/).length).toBeGreaterThan(0);
  });
});

describe('the list of pieces under a card', () => {
  it('strikes dropped work through, the same as finished work', () => {
    const { container } = render(<EpicCard {...withPieces('manager_review', 1, 1)} />);
    const titles = Array.from(container.querySelectorAll('p.text-xs.font-medium'));
    expect(titles.length).toBeGreaterThan(0);
    // Nobody is waiting on any of these, so none of them is drawn as live work.
    for (const t of titles) {
      expect(t.className, t.textContent ?? '').toMatch(/line-through/);
      expect(t.className, t.textContent ?? '').not.toMatch(/text-t-secondary/);
    }
  });

  it('leaves work that is still standing undrawn as done', () => {
    const props = withPieces('open', 0, 1);
    const live: Bead = { ...child, id: 'test-1.live', status: 'in_progress' };
    const { container } = render(
      <EpicCard
        {...props}
        epic={{ ...props.epic, children: [...props.epic.children, live.id] }}
        allBeads={[...props.allBeads, live]}
      />
    );
    const titles = Array.from(container.querySelectorAll('p.text-xs.font-medium'));
    const standingRow = titles.find((t) => !t.className.includes('line-through'));
    expect(standingRow, 'the piece being worked on must not be struck through').toBeTruthy();
    expect(titles.filter((t) => t.className.includes('line-through')).length).toBe(1);
  });
});

describe('what the card asks the code host about', () => {
  it('never asks about a piece that was dropped', async () => {
    const api = await import('@/lib/api');
    render(<EpicCard {...withPieces('manager_review', 10, 4)} />);
    await waitFor(() => expect(api.git.prStatus).not.toHaveBeenCalled());
    // Nothing is standing here, so nothing is asked about at all — and in
    // particular not the four dropped pieces, which nobody is working on.
    const asked = vi.mocked(api.git.prStatus).mock.calls.map((c) => c[1]);
    expect(asked.filter((id) => String(id).includes('.x'))).toEqual([]);
  });

  it('still asks about a piece that is being worked on', async () => {
    const api = await import('@/lib/api');
    const props = withPieces('open', 1, 1);
    const live: Bead = { ...child, id: 'test-1.live', status: 'in_progress' };
    render(
      <EpicCard
        {...props}
        epic={{ ...props.epic, children: [...props.epic.children, live.id] }}
        allBeads={[...props.allBeads, live]}
      />
    );
    await waitFor(() =>
      expect(vi.mocked(api.git.prStatus).mock.calls.map((c) => c[1])).toEqual([live.id])
    );
  });
});
