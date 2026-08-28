import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync('src/workbench/chat-tab.tsx', 'utf8');

describe('model and reasoning defaults', () => {
  it('reads and writes provider-native defaults instead of browser storage or start overrides', () => {
    expect(source).toContain("type: 'provider-defaults.read'");
    expect(source).toContain("type: 'provider-defaults.write'");
    expect(source).not.toContain("const MODEL_DEFAULTS = 'workbench.model-defaults'");
    expect(source).not.toContain("const EFFORT_DEFAULTS = 'workbench.effort-defaults'");
    expect(source).not.toContain('model: modelDefaults[brand]');
    expect(source).not.toContain('effort: effortDefaults[brand]');
  });

  it('puts a default action beside every model and effort selector row', () => {
    expect(source).toContain('data-testid={`${testid}-default-${o.value}`}');
    expect(source).toContain('defaultValue={modelDefaults[sessionBrand] ?? null}');
    expect(source).toContain('defaultValue={effortDefaults[sessionBrand] ?? null}');
  });
});

describe('new-chat provider default', () => {
  it('draws its saved state as a checkbox and lets the user clear it', () => {
    expect(source).toContain('data-testid="new-chat-default"');
    expect(source).toContain('role="checkbox"');
    expect(source).toContain('aria-checked={newChatDefault === newBrand}');
    expect(source).toContain("setNewChatDefault(newChatDefault === newBrand ? 'ask' : newBrand)");
    expect(source).toContain('<SquareCheck aria-hidden="true" />');
    expect(source).toContain('<Square aria-hidden="true" />');
  });
});
