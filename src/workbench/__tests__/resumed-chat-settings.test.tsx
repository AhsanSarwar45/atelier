import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { composerMenu, Picker } from '@/workbench/chat-tab';
import { EMPTY } from '@/workbench/fold';

describe('a setting on a resumed chat', () => {
  it('has every cold-start Codex control before a provider menu arrives', () => {
    const menu = composerMenu(EMPTY.menu, 'codex', 'gpt-5.6-sol', 'default');

    expect(menu.permissionModes).toEqual(['on-request', 'never']);
    expect(menu.models.map((choice) => choice.value)).toEqual(['default', 'gpt-5.6-sol']);
    expect(menu.efforts.map((choice) => choice.value)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
    expect(menu.collaborationModes.map((choice) => choice.value)).toEqual(['default', 'plan']);
  });

  it('never replaces a live provider menu with fallback choices', () => {
    const live = {
      ...EMPTY.menu,
      permissionModes: ['live-mode'],
      models: [{ value: 'live-model', displayName: 'Live model' }],
      efforts: [{ value: 'live-effort', displayName: 'Live effort' }],
      collaborationModes: [{ value: 'live-collaboration', displayName: 'Live collaboration' }],
    };
    expect(composerMenu(live, 'codex', 'old-model', 'old-mode')).toEqual(live);
  });

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
