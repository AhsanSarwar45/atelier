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
  const SONNET_HINT = 'Sonnet 5 · Efficient for routine tasks';
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

  function cardFor(value: string): HTMLElement {
    const card = screen.getAllByTestId('model-picker-option').find((el) => el.dataset.value === value);
    if (!card) throw new Error(`no option card for ${value}`);
    return card;
  }

  it('draws the description inside the card the reader clicks', () => {
    openMenu();

    expect(cardFor('sonnet')).toContainElement(screen.getByText(SONNET_HINT));
  });

  it('picks the option when the description itself is clicked', () => {
    const onPick = openMenu();

    fireEvent.click(screen.getByText(SONNET_HINT));

    expect(onPick).toHaveBeenCalledWith('sonnet');
  });
});
