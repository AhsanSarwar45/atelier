import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { configOptionChoices } from '@/workbench/chat-tab';

describe('provider-announced session options', () => {
  it('draws a boolean capability as a readable enabled/disabled choice', () => {
    expect(configOptionChoices({
      id: 'fast-mode',
      name: 'Fast mode',
      type: 'boolean',
      currentValue: false,
    })).toEqual([
      { value: 'true', label: 'Enabled' },
      { value: 'false', label: 'Disabled' },
    ]);
  });

  it('keeps an arbitrary provider select catalog and its descriptions', () => {
    expect(configOptionChoices({
      id: 'future-option',
      name: 'Future option',
      type: 'select',
      currentValue: 'balanced',
      options: [{ value: 'balanced', name: 'Balanced', description: 'Use the provider default.' }],
    })).toEqual([{ value: 'balanced', label: 'Balanced', hint: 'Use the provider default.' }]);
  });

  it('sends boolean values through the generic command instead of a Codex-specific command', () => {
    const source = readFileSync(resolve(__dirname, '../chat-tab.tsx'), 'utf8');
    const controls = source.slice(source.indexOf('export function SessionConfigPickers'), source.indexOf('export function configOptionChoices'));
    expect(controls).toContain("type: 'session.config-option'");
    expect(controls).toContain("option.type === 'boolean' ? selected === 'true' : selected");
    expect(controls).not.toContain('session.codex');
  });
});
