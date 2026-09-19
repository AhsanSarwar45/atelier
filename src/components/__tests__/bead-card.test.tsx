/**
 * A card nobody is waiting on reads the same in every shape.
 *
 * There are three card shapes across the eleven themes, and each one draws the
 * same card. A card whose work is finished or dropped is dimmed and struck
 * through — but only one shape struck it, so the same settled card told a
 * reader two different things depending on the theme they happened to pick.
 */
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { BeadCard } from '../bead-card';
import { closeBead } from '@/lib/cli';
import type { CardLayout } from '@/lib/themes';
import type { Bead, BeadStatus } from '@/types';

vi.mock('@/lib/api', () => ({ git: {} }));
vi.mock('@/lib/cli', () => ({ closeBead: vi.fn().mockResolvedValue(undefined) }));

/** What the screen was told to say, without a toaster in the tree to say it. */
const said = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/use-toast', () => ({ toast: said }));

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

const beadIn = (status: BeadStatus): Bead => ({
  id: 'test-9', title: 'A piece of work', status, priority: 0,
  issue_type: 'task', owner: 'someone', created_at: '', updated_at: '', comments: [],
});

const draw = (status: BeadStatus) => {
  const bead = beadIn(status);
  const { container } = render(
    <BeadCard bead={bead} statusById={new Map([[bead.id, status]])} onSelect={vi.fn()} />
  );
  return container.querySelector('.theme-card') as HTMLElement;
};

/** Does anything on this card carry the strike, wherever the shape puts it? */
const struck = (card: HTMLElement) =>
  card.className.includes('line-through') || card.querySelector('.line-through') !== null;

const dimmed = (card: HTMLElement) => /opacity-4\d/.test(card.className);

describe('a card nobody is waiting on', () => {
  for (const shape of LAYOUTS) {
    it(`is struck through in the ${shape} shape when the work was finished`, () => {
      layout = shape;
      expect(struck(draw('closed'))).toBe(true);
    });

    it(`is struck through in the ${shape} shape when the work was dropped`, () => {
      layout = shape;
      expect(struck(draw('cancelled'))).toBe(true);
    });

    it(`is dimmed in the ${shape} shape`, () => {
      layout = shape;
      expect(dimmed(draw('closed'))).toBe(true);
    });
  }
});

describe('a card someone is still waiting on', () => {
  for (const shape of LAYOUTS) {
    it(`is neither struck nor dimmed in the ${shape} shape`, () => {
      layout = shape;
      const card = draw('in_progress');
      expect(struck(card)).toBe(false);
      expect(dimmed(card)).toBe(false);
    });
  }
});

/**
 * Who is offered the sign-off on a plain card.
 *
 * Manager Review is the one column no session may move a card out of
 * (`server/src/board_gate.rs` refuses every drag out of it), so the screen is
 * the only place a card there can be finished. The button was built inside the
 * job card alone, so a plain card that reached the manager's column could be
 * finished from nowhere at all — which is how bw-68kf.2 got stuck (bw-2l3k).
 */
describe('the sign-off on a plain card', () => {
  const FINISH = /mark done/i;

  const drawFor = (status: BeadStatus, onUpdate = vi.fn()) => {
    const bead = beadIn(status);
    return render(
      <BeadCard
        bead={bead}
        statusById={new Map([[bead.id, status]])}
        onSelect={vi.fn()}
        projectPath="/some/project"
        onUpdate={onUpdate}
      />
    );
  };

  for (const shape of LAYOUTS) {
    it(`is drawn in the ${shape} shape on a card in the manager's column`, () => {
      layout = shape;
      expect(drawFor('manager_review').getByRole('button', { name: FINISH })).toBeTruthy();
    });

    it(`is drawn nowhere else in the ${shape} shape`, () => {
      layout = shape;
      for (const status of ['open', 'in_progress', 'in_review', 'closed'] as BeadStatus[]) {
        expect(drawFor(status).queryByRole('button', { name: FINISH })).toBeNull();
      }
    });
  }

  it('closes the card on the board and reads the board again', async () => {
    const onUpdate = vi.fn();
    const view = drawFor('manager_review', onUpdate);
    fireEvent.click(view.getByRole('button', { name: FINISH }));

    await waitFor(() => expect(closeBead).toHaveBeenCalledWith('test-9', '/some/project'));
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
  });

  it('says the press landed before the board has answered', async () => {
    let finish: () => void = () => {};
    vi.mocked(closeBead).mockImplementationOnce(
      () => new Promise<void>((resolve) => { finish = resolve; }));

    const view = drawFor('manager_review');
    fireEvent.click(view.getByRole('button', { name: FINISH }));

    await waitFor(() => expect(said).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringMatching(/marking test-9 done/i) })));
    await act(async () => { finish(); });
  });

  it('says so when the board refuses the close', async () => {
    vi.mocked(closeBead).mockRejectedValueOnce(new Error('waiting on the manager'));

    const view = drawFor('manager_review');
    fireEvent.click(view.getByRole('button', { name: FINISH }));

    await waitFor(() => expect(said).toHaveBeenCalledWith(expect.objectContaining({
      variant: 'destructive',
      description: 'waiting on the manager',
    })));
  });
});
