import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('the provider-neutral collaboration mode control', () => {
  const source = readFileSync(resolve(__dirname, '../chat-tab.tsx'), 'utf8');
  const picker = source.slice(source.indexOf('testid="collaboration-mode-picker"'));
  const block = picker.slice(0, picker.indexOf('/>') + 2);

  it('is offered only from modes announced by this session', () => {
    expect(source).toContain('view.menu.collaborationModes.length > 0');
    expect(block).toContain('view.menu.collaborationModes.map');
    expect(block).toContain('value: mode.value');
    expect(block).toContain('label: mode.displayName');
    expect(block).toContain('hint: mode.description');
  });

  it('pins the selected working style independently of permission mode', () => {
    expect(block).toContain("type: 'session.collaboration-mode', sessionId, mode");
    expect(block).toContain('current={view.collaborationMode}');
    expect(block).not.toContain("type: 'session.mode'");
  });

  it('offers the same provider modes on narrow screens', () => {
    expect(source).toContain('testid="mobile-collaboration-mode-picker"');
  });
});
