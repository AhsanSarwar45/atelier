/**
 * What an open chat can say about itself on one line.
 *
 * Measured, a long-running chat had 26 cards and drew them as a row 2277 px
 * wide inside a pane about 700 px wide, squeezing the words that name the agent
 * to 37 px (docs/agent-workbench.md §8.2.1).
 */
import { describe, expect, it } from 'vitest';

import { cardsOnTheLine } from '@/workbench/cards-on-the-line';

const many = Array.from({ length: 26 }, (_, i) => `cor-qrnj.${i + 1}`);

describe('cards on the open chat’s line', () => {
  it('a few cards all go on the line', () => {
    expect(cardsOnTheLine(['a', 'b'])).toEqual({ shown: ['a', 'b'], rest: [] });
  });

  it('the room’s worth go on the line and the rest become a count', () => {
    const { shown, rest } = cardsOnTheLine(many);
    expect(shown).toHaveLength(3);
    expect(rest).toHaveLength(23);
    expect(shown[0]).toBe('cor-qrnj.1');
  });

  it('no card is lost — every one is either drawn or counted', () => {
    const { shown, rest } = cardsOnTheLine(many);
    expect([...shown, ...rest]).toEqual(many);
  });

  it('a chat with no cards asks for no room', () => {
    expect(cardsOnTheLine([])).toEqual({ shown: [], rest: [] });
  });
});
