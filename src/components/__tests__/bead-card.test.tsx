/**
 * A card nobody is waiting on reads the same in every shape.
 *
 * There are three card shapes across the eleven themes, and each one draws the
 * same card. A card whose work is finished or dropped is dimmed and struck
 * through — but only one shape struck it, so the same settled card told a
 * reader two different things depending on the theme they happened to pick.
 */
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { BeadCard } from '../bead-card';
import type { CardLayout } from '@/lib/themes';
import type { Bead, BeadStatus } from '@/types';

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
