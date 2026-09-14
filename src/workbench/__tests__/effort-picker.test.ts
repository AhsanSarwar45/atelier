import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('the composer effort picker', () => {
  const source = readFileSync(resolve(__dirname, '../chat-tab.tsx'), 'utf8');
  const picker = source.slice(source.indexOf('testid="effort-picker"'));
  const block = picker.slice(0, picker.indexOf('/>') + 2);

  it('lists the live choices, or the provider fallback while a cold chat has no menu', () => {
    expect(block).toContain('composer.efforts.map');
    expect(block).toContain('value: effort.value');
    expect(block).toContain('label: effort.displayName');
    expect(block).toContain('hint: effort.description');
  });

  it('pins the chosen effort to the chat whose composer owns the picker', () => {
    expect(block).toContain("type: 'session.effort', sessionId, effort");
    expect(block).toContain('current={view.effort ?? null}');
  });
});
