import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Picker } from '@/workbench/chat-tab';

/**
 * A picker option is one card. The description is what tells the reader which
 * model he is choosing, so it has to belong to the card he clicks — not sit
 * beneath it as a caption that highlights on nothing and answers no click
 * (bw-xtic.1).
 */
describe('a picker option card', () => {
  // The line the app really composes: the install's own words, then the rate
  // the register charges — two separators, so gluing one is not enough.
  const SONNET_HINT = 'Sonnet 5 · Efficient for routine tasks · fast\n$2/$10 per Mtok';
  const options = [
    { value: 'opus', label: 'Opus', hint: 'Opus 5 · Best for everyday, complex tasks' },
    { value: 'sonnet', label: 'Sonnet', hint: SONNET_HINT },
  ];

  function openMenu(onPick = vi.fn()) {
    render(
      <Picker
        icon={null}
        label="Model"
        testid="model-picker"
        current="opus"
        asleep={false}
        options={options}
        onPick={onPick}
      />,
    );
    // Radix opens on the keyboard as readily as on a pointer, and a keypress is
    // the one a bench with no layout can deliver honestly.
    fireEvent.keyDown(screen.getByTestId('model-picker'), { key: 'Enter' });
    return onPick;
  }

  /** The description as drawn, which is the thing a reader actually clicks. */
  function hintOf(value: string): HTMLElement {
    const hint = cardFor(value).querySelector('[data-testid="model-picker-option-hint"]');
    if (!hint) throw new Error(`no description drawn for ${value}`);
    return hint as HTMLElement;
  }

  function cardFor(value: string): HTMLElement {
    const card = screen.getAllByTestId('model-picker-option').find((el) => el.dataset.value === value);
    if (!card) throw new Error(`no option card for ${value}`);
    return card;
  }

  it('draws the description inside the card the reader clicks', () => {
    openMenu();

    expect(cardFor('sonnet')).toContainElement(hintOf('sonnet'));
  });

  /**
   * A description that asks for a break gets one. The rate is composed onto a
   * line of its own rather than left to wrap there, which is what stopped every
   * row opening its second line on a stray separator (bw-xtic.10).
   */
  it('honours a break the description asked for', () => {
    openMenu();

    const drawn = cardFor('sonnet').querySelector('[data-testid="model-picker-option-hint"]');

    expect(drawn?.textContent?.split('\n')).toHaveLength(2);
    // A deliberate break is left alone: no separator is bound across it.
    expect(drawn?.textContent).toContain('\n$2/$10 per Mtok');
    expect(drawn?.className).toContain('whitespace-pre-line');
  });

  /**
   * The fault: a description wraps in a 288px menu, and a `·` with an ordinary
   * space each side could fall to the head of the next line — which is exactly
   * what every alias row on screen did, opening its second line on a stray dot
   * (bw-xtic.10). The space *before* each separator is bound, so the separator
   * stays with the clause it closes and the break falls after it.
   */
  it('ties each separator to the phrase it closes, so no line opens on a dot', () => {
    openMenu();

    const drawn = cardFor('sonnet').querySelector('[data-testid="model-picker-option-hint"]');

    expect(drawn?.textContent).toBe('Sonnet 5\u00a0· Efficient for routine tasks\u00a0· fast\n$2/$10 per Mtok');
    // Every separator, not just the first, and no ordinary run of " · " left.
    expect(drawn?.textContent).not.toMatch(/ · /);
    // Nothing a wrap could carry down: no separator still leads a breakable space.
    expect(drawn?.textContent).not.toMatch(/ ·/);
  });

  it('picks the option when the description itself is clicked', () => {
    const onPick = openMenu();

    fireEvent.click(hintOf('sonnet'));

    expect(onPick).toHaveBeenCalledWith('sonnet');
  });

  /**
   * The menu answers two different questions — "the current Opus" and "Opus
   * 4.6" — so the bands are ruled apart, and a model the install cannot run is
   * still shown, saying why, rather than quietly left out (bw-xtic.2).
   */
  describe('with two bands and a model that cannot be run', () => {
    const banded = [
      { value: 'opus', label: 'Opus', hint: 'Opus 5', group: 'alias' },
      { value: 'sonnet', label: 'Sonnet', hint: 'Sonnet 5', group: 'alias' },
      { value: 'claude-opus-4-8', label: 'Opus 4.8', hint: 'The strongest of the Opus 4 series', group: 'version' },
      { value: 'claude-opus-4-1', label: 'Opus 4.1', hint: 'The Opus that followed 4', group: 'version', unavailable: 'Retired on 5 August 2026' },
    ];

    function openBanded(onPick = vi.fn()) {
      render(
        <Picker
          icon={null}
          label="Model"
          testid="model-picker"
          current="opus"
          asleep={false}
          options={banded}
          onPick={onPick}
        />,
      );
      fireEvent.keyDown(screen.getByTestId('model-picker'), { key: 'Enter' });
      return onPick;
    }

    it('rules one line, where the aliases give way to the versions', () => {
      openBanded();

      expect(screen.getAllByRole('separator')).toHaveLength(1);
    });

    it('says why a model cannot be run in place of describing it', () => {
      openBanded();

      expect(cardFor('claude-opus-4-1')).toHaveTextContent('Retired on 5 August 2026');
      expect(cardFor('claude-opus-4-1')).not.toHaveTextContent('The Opus that followed 4');
    });

    it('refuses the pick rather than sending a model the install would reject', () => {
      const onPick = openBanded();

      fireEvent.click(screen.getByText('Retired on 5 August 2026'));

      expect(onPick).not.toHaveBeenCalled();
    });

    it('still offers every model it can run', () => {
      const onPick = openBanded();

      fireEvent.click(screen.getByText('The strongest of the Opus 4 series'));

      expect(onPick).toHaveBeenCalledWith('claude-opus-4-8');
    });
  });
});
