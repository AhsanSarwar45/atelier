import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Picker } from '@/workbench/chat-tab';

describe('a setting on a resumed chat', () => {
  it.each([
    ['mode-picker', false],
    ['collaboration-mode-picker', false],
    ['model-picker', true],
    ['effort-picker', true],
  ])('opens and offers its session choices consistently: %s', (testid, hasDefault) => {
    const onPick = vi.fn();
    render(
      <Picker
        icon={null}
        label="Chat setting"
        testid={testid}
        current="one"
        asleep
        options={[
          { value: 'one', label: 'One' },
          { value: 'two', label: 'Two' },
        ]}
        onPick={onPick}
        {...(hasDefault ? { defaultValue: 'one', onDefault: vi.fn() } : {})}
      />,
    );

    const trigger = screen.getByTestId(testid);
    expect(trigger).toBeEnabled();
    fireEvent.keyDown(trigger, { key: 'Enter' });

    const choice = screen.getAllByTestId(`${testid}-option`)[1]!;
    expect(choice).toBeEnabled();
    fireEvent.click(choice);
    expect(onPick).toHaveBeenCalledWith('two');
  });
});
