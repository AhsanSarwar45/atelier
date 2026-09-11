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
    expect(source).toContain("defaultValue={sessionBrand === 'local' ? null : modelDefaults[sessionBrand] ?? null}");
    expect(source).toContain('defaultValue={effortDefaults[sessionBrand] ?? null}');
  });
});

describe('new-chat provider default', () => {
  it('draws its saved state as a checkbox and lets the user clear it', () => {
    expect(source).toContain('data-testid="new-chat-default"');
    expect(source).toContain('<Checkbox');
    expect(source).toContain('checked={newChatDefault === newBrand}');
    expect(source).toContain("setNewChatDefault(checked ? newBrand : 'ask')");
    expect(source).toContain("import { Checkbox } from '@/components/ui/checkbox'");
  });

  it('keeps the choice in the app and not in this browser', () => {
    // The star beside a provider is drawn like the model and effort stars, and
    // those have never been kept here. One of the three remembered somewhere
    // else is a difference a person only finds by being surprised by it.
    expect(source).not.toContain("const NEW_CHAT_DEFAULT = 'workbench.new-chat-default'");
    expect(source).not.toContain('localStorage.setItem(NEW_CHAT_DEFAULT');
    expect(source).toContain('loadNewChatDefaults()');
    expect(source).toContain('saveNewChatProvider(brand)');
  });

  it('never starts a provider the installed backend says is unavailable', () => {
    expect(source).toContain('if (!providerIsAvailable(providers, brand))');
    expect(source).toContain('disabled={starting || !newBrandAvailable || whereMissing !== null}');
    expect(source).toContain('disabled={!newBrandAvailable}');
  });
});
