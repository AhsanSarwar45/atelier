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
    expect(source).toContain('testid={`${testid}-default-${o.value}`}');
    expect(source).toContain("defaultValue={sessionBrand === 'local' ? null : modelDefaults[sessionBrand] ?? null}");
    expect(source).toContain('defaultValue={effortDefaults[sessionBrand] ?? null}');
  });
});

describe('new-chat provider default', () => {
  it('draws a star on each provider rather than a checkbox for whichever is selected', () => {
    // The checkbox stood in the footer and could only ever speak for the
    // provider that happened to be selected; the star says which one it means
    // by being on it, the way the model and effort stars do.
    expect(source).toContain('testid={`new-chat-provider-default-${provider.brand}`}');
    expect(source).toContain("setNewChatDefault(newChatDefault === provider.brand ? 'ask' : provider.brand)");
    expect(source).not.toContain('data-testid="new-chat-default"');
    expect(source).not.toContain("import { Checkbox } from '@/components/ui/checkbox'");
  });

  it('opens the dialog even when a provider is starred', () => {
    // A default is what the dialog opens holding. Skipping the dialog would
    // answer which account and where to work without asking (bw-5ihw.6).
    expect(source).toContain("setShowing('new-chat');\n  }, [availableBrand, newBrand, newChatDefault, providers]);");
    expect(source).not.toContain('void start(newChatDefault)');
  });

  it('offers each brand its accounts, and the local brand none', () => {
    expect(source).toContain("newBrand !== 'local' && (newAccounts.length > 1 || newAccountsUnread)");
    expect(source).toContain('testid={`new-chat-profile-default-${profile.id}`}');
    expect(source).toContain("start(newBrand, newWhere, newBrand === 'local' ? undefined : newAccount)");
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
    expect(source).toContain('disabled={!provider.available}');
  });
});
