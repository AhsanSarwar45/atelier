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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { EpicCard } from '../epic-card';
import { indexBoard } from '@/lib/board-index';
import { closeBead } from '@/lib/cli';
import type { CardLayout } from '@/lib/themes';
import type { Bead, BeadStatus, Epic } from '@/types';

vi.mock('@/lib/cli', () => ({ closeBead: vi.fn().mockResolvedValue(undefined) }));

/** What the screen was told to say, without a toaster in the tree to say it. */
const said = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/use-toast', () => ({ toast: said }));
vi.mock('@/lib/api', () => ({ git: {} }));

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

/** The lookup the board builds once and every card is handed. */
const lookup = (beads: Bead[]): ReadonlyMap<string, string> =>
  new Map(beads.map(b => [b.id, b.status]));
const byId = (beads: Bead[]): ReadonlyMap<string, Bead> =>
  new Map(beads.map(b => [b.id, b]));

const draw = (status: BeadStatus) =>
  render(
    <EpicCard
      epic={epicIn(status)}
      beadById={byId([child])}
      statusById={lookup([child])}
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
    beadById: byId(pieces),
    statusById: lookup(pieces),
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
        beadById={byId([child, unfinished])}
        statusById={lookup([child, unfinished])}
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

  it('is not drawn while one piece of a large job is still open', () => {
    // 199 of 200 rounds to a hundred. The gate used to read that rounded
    // number and offer the manager a sign-off on unfinished work; the card
    // used to print it and draw the full green bar over it.
    const props = withPieces('manager_review', 199, 0);
    const open: Bead = { ...child, id: 'test-1.open', status: 'open' };
    render(
      <EpicCard
        {...props}
        epic={{ ...props.epic, children: [...props.epic.children, open.id] }}
        beadById={byId([...props.beadById.values(), open])}
        statusById={lookup([...props.beadById.values(), open])}
      />
    );
    expect(screen.getByText('99%')).toBeInTheDocument();
    expect(screen.queryByText('100%')).toBeNull();
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
  it('renders 50 job cards after walking the board once', () => {
    const epics = Array.from({ length: 50 }, (_, epicIndex) => ({
      ...epicIn('open'),
      id: `job-${epicIndex}`,
      title: `Job ${epicIndex}`,
      children: Array.from({ length: 12 }, (_, childIndex) =>
        `job-${epicIndex}.${childIndex}`),
    }));
    const pieces = epics.flatMap((epic) => epic.children.map((id) => ({
      ...child,
      id,
    })));
    const board = [
      ...epics,
      ...pieces,
      ...Array.from({ length: 3168 - epics.length - pieces.length }, (_, index) => ({
        ...child,
        id: `unrelated-${index}`,
      })),
    ];
    let walks = 0;
    const countedBoard: Iterable<Bead> = {
      *[Symbol.iterator]() {
        walks += 1;
        yield* board;
      },
    };
    const { beadById, statusById } = indexBoard(countedBoard);

    render(<>{epics.map((epic) => (
      <EpicCard
        key={epic.id}
        epic={epic}
        beadById={beadById}
        statusById={statusById}
        onSelect={vi.fn()}
        onChildClick={vi.fn()}
      />
    ))}</>);

    expect(walks).toBe(1);
  });

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

  it.each(LAYOUTS)('states the count once above the list, in the %s shape', (shape) => {
    // The property-tags shape drew a summary badge and the progress block
    // together and both said it, so one job told the reader twice. The list's
    // own header still says it, because that is what explains its extra rows.
    layout = shape;
    const { container } = render(<EpicCard {...withPieces('manager_review', 10, 4)} />);
    const header = Array.from(container.querySelectorAll('button'))
      .find(b => /Child Tasks/.test(b.textContent ?? ''));
    const aboveTheList = (container.textContent ?? '')
      .replace(header?.textContent ?? '', '');
    const said = aboveTheList.match(/dropped/g) ?? [];
    expect(said.length, aboveTheList).toBe(1);
  });

  it.each(LAYOUTS)('says nothing about work in flight when there is none, in the %s shape', (shape) => {
    // Denials are not news. 26 of the 29 jobs on the manager's board have
    // nothing in flight, and every one of their cards carried a line saying so
    // — a line two of the three shapes had never drawn before.
    layout = shape;
    render(<EpicCard {...withPieces('open', 2, 0)} />);
    expect(screen.queryByText(/in progress/)).toBeNull();
    expect(screen.queryByText(/blocked/)).toBeNull();
  });

  it('paints the in-progress dot the In Progress colour, not Todo', () => {
    const props = withPieces('open', 1, 0);
    const live: Bead = { ...child, id: 'test-1.live', status: 'in_progress' };
    const { container } = render(
      <EpicCard
        {...props}
        epic={{ ...props.epic, children: [...props.epic.children, live.id] }}
        beadById={byId([...props.beadById.values(), live])}
        statusById={lookup([...props.beadById.values(), live])}
      />
    );
    const label = screen.getByText(/1 in progress/);
    const dot = label.querySelector('div');
    expect(dot?.className).toMatch(/status-progress/);
    expect(dot?.className).not.toMatch(/status-open/);
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
        beadById={byId([...props.beadById.values(), live])}
        statusById={lookup([...props.beadById.values(), live])}
      />
    );
    expect(screen.getByText(/1 in progress/)).toBeInTheDocument();
    expect(screen.getAllByText(/1 dropped/).length).toBeGreaterThan(0);
  });
});

describe('how loudly a card is drawn', () => {
  it.each(LAYOUTS)('draws a finished job back, in the %s shape', (shape) => {
    layout = shape;
    const { container } = render(<EpicCard {...withPieces('closed', 2, 0)} />);
    expect(container.querySelector('.theme-card')?.className).toMatch(/opacity-45/);
  });

  it.each(LAYOUTS)('draws a dropped job back, in the %s shape', (shape) => {
    // Both cards this job was opened over sat in Cancelled at full strength
    // while every plain card beside them was dimmed.
    layout = shape;
    const { container } = render(<EpicCard {...withPieces('cancelled', 0, 2)} />);
    expect(container.querySelector('.theme-card')?.className).toMatch(/opacity-45/);
  });

  it.each(LAYOUTS)('leaves a job somebody is waiting on at full strength, in the %s shape', (shape) => {
    layout = shape;
    const { container } = render(<EpicCard {...withPieces('in_progress', 1, 0)} />);
    expect(container.querySelector('.theme-card')?.className).not.toMatch(/opacity-45/);
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
        beadById={byId([...props.beadById.values(), live])}
        statusById={lookup([...props.beadById.values(), live])}
      />
    );
    const titles = Array.from(container.querySelectorAll('p.text-xs.font-medium'));
    const standingRow = titles.find((t) => !t.className.includes('line-through'));
    expect(standingRow, 'the piece being worked on must not be struck through').toBeTruthy();
    expect(titles.filter((t) => t.className.includes('line-through')).length).toBe(1);
  });
});

describe('what the card asks anyone else about', () => {
  it('asks nothing at all while it is drawn', async () => {
    // The card used to ask a question per piece every thirty seconds, and each
    // one went across the internet before it could be answered. Nothing on a
    // card is worth a network call: everything it draws came with the board.
    const asked = vi.fn();
    vi.stubGlobal('fetch', asked);
    render(<EpicCard {...withPieces('open', 3, 1)} />);
    await waitFor(() => expect(screen.getByText(/Child Tasks/)).toBeInTheDocument());
    expect(asked).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

/**
 * What a press says while the board is being written.
 *
 * Finishing a job runs the board program: a second or so while the machine is
 * quiet, and 35 seconds measured through a browser while other agents were
 * writing. All the press did until now was grey a small button and swap its
 * word, so the manager pressed, saw a screen that had not changed, and pressed
 * again (bw-x1fv.8).
 */
describe('the answer to a press', () => {
  /** A close that hangs until the case lets it finish, standing in for a busy board. */
  const closeThatHangs = () => {
    let finish!: () => void;
    let refuse!: (why: Error) => void;
    vi.mocked(closeBead).mockImplementation(
      () => new Promise<void>((ok, no) => {
        finish = () => ok();
        refuse = (why) => no(why);
      }),
    );
    return { finish: () => finish(), refuse: (why: Error) => refuse(why) };
  };

  const press = () => fireEvent.click(screen.getByRole('button', { name: FINISH }));

  it('says the press was heard before the board has answered', () => {
    closeThatHangs();
    draw('manager_review');
    press();

    // Said on the press, not on the answer: the answer is what takes the time.
    expect(said).toHaveBeenCalledTimes(1);
    expect(said.mock.calls[0][0].title).toMatch(/marking test-1 done/i);
  });

  it('marks the card itself, so a column of finished jobs shows which one', async () => {
    const board = closeThatHangs();
    draw('manager_review');
    press();

    expect(document.querySelector('[data-bead-id="test-1"]')).toHaveAttribute('data-marking', 'true');
    await act(async () => { board.finish(); });
    expect(document.querySelector('[data-bead-id="test-1"]')).not.toHaveAttribute('data-marking');
  });

  it('says the job is done, and has the board read again', async () => {
    const board = closeThatHangs();
    const afterwards = vi.fn();
    render(
      <EpicCard
        epic={epicIn('manager_review')}
        beadById={byId([child])}
        statusById={lookup([child])}
        onSelect={vi.fn()}
        onChildClick={vi.fn()}
        projectPath="/test/project"
        onUpdate={afterwards}
      />
    );
    press();
    await act(async () => { board.finish(); });

    expect(said.mock.calls.at(-1)?.[0].title).toMatch(/test-1 is done/i);
    expect(afterwards, 'the board was never read again, so the card sat in the column').toHaveBeenCalled();
  });

  it('says a sign-off that failed failed, instead of stopping silently', async () => {
    const board = closeThatHangs();
    const afterwards = vi.fn();
    render(
      <EpicCard
        epic={epicIn('manager_review')}
        beadById={byId([child])}
        statusById={lookup([child])}
        onSelect={vi.fn()}
        onChildClick={vi.fn()}
        projectPath="/test/project"
        onUpdate={afterwards}
      />
    );
    press();
    await act(async () => { board.refuse(new Error('Command timed out after 30 seconds')); });

    const last = said.mock.calls.at(-1)?.[0];
    expect(last.variant).toBe('destructive');
    expect(last.description).toMatch(/timed out/i);
    // Read again even so: the commonest failure here is a request giving up on
    // a close that went on to succeed, and the board is what settles it.
    expect(afterwards).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: FINISH })).toBeEnabled();
  });
});
