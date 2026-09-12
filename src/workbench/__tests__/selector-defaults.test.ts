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
    expect(source).toContain('testid: `new-chat-provider-default-${provider.brand}`,');
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
    expect(source).toContain('testid: `new-chat-profile-default-${profile.id}`,');
    expect(source).toContain("start(newBrand, newWhere, newBrand === 'local' ? undefined : newAccount)");
  });

  it('attaches each star to the choice it belongs to, as one split control', () => {
    // Loose beside the button, with a gap on either side of it, a row of four
    // choices read as eight scattered things; joined, it reads as four
    // controls that happen to have two halves (bw-ospn.1).
    expect(source).toContain('<ChoiceWithStar');
    expect(source).not.toContain('<div key={provider.brand} className="flex items-center gap-1">');
    expect(source).not.toContain('<div key={profile.id} className="flex items-center gap-1">');
    // The seam: the choice is square on its right, the star square on its
    // left, and one line between them either way the pair is painted.
    const split = source.slice(source.indexOf('function ChoiceWithStar('), source.indexOf('export function Picker('));
    expect(split).toContain('rounded-r-none');
    expect(split).toContain("chosen ? 'border-l border-primary-foreground/20' : '-ml-px'");
    expect(split).toContain('segment');
    // Both halves wear the same face, so neither looks like a stray.
    expect(split).toContain("const variant = chosen ? 'primary' : 'outline';");
    expect(split).toContain('variant={variant}');
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

describe('the new-chat dialog’s three sections', () => {
  const where = readFileSync('src/workbench/where-to-work.tsx', 'utf8');

  it('titles each of them with the one heading, and none of them by hand', () => {
    // A dialog title over the agents, sentence case over the accounts and
    // small caps over the worktree made three questions of equal weight look
    // like three unrelated things (bw-ospn.3).
    expect(source).toContain('<SectionHeading>Agent</SectionHeading>');
    expect(source).toContain('<SectionHeading>Account</SectionHeading>');
    expect(where).toContain('<SectionHeading>Worktree</SectionHeading>');
    expect(source).not.toContain('<p className="mb-1.5 text-xs font-medium text-t-secondary">Account</p>');
    expect(where).not.toContain('uppercase tracking-wider');
  });

  it('says what it is asking in its headings rather than in a sentence', () => {
    expect(source).toContain('<DialogTitle>New chat</DialogTitle>');
    expect(source).not.toContain('This choice applies to this new chat.');
  });

  it('stands every row in it at the same height', () => {
    // The worktree row was a size smaller than the agents and accounts above
    // it, which is the same complaint one line further down.
    expect(where).not.toContain('size="sm"');
  });
});

describe('the screen with no chat on it', () => {
  it('asks nothing the dialog asks, and opens the dialog instead', () => {
    // It used to carry its own agent buttons, its own list of why one was
    // grey, and its own where-to-work picker — the dialog's questions over
    // again, in a second place that had to be kept answering them as the
    // dialog grew an account section (bw-5ihw.9).
    const empty = source.slice(source.indexOf('if (!sessionId) {'), source.indexOf('data-testid="chat-tab"'));
    expect(empty).toContain('onClick={() => newChat()}');
    expect(empty).toContain('New Chat');
    expect(empty).not.toContain('agent-${provider.brand}');
    expect(empty).not.toContain('<WhereToWork');
    expect(empty).not.toContain('void start(');
  });

  it('still says why the button is grey, which is the one thing the dialog cannot say', () => {
    const empty = source.slice(source.indexOf('if (!sessionId) {'), source.indexOf('data-testid="chat-tab"'));
    expect(empty).toContain('{!availableBrand && (');
    expect(empty).toContain('data-testid="provider-unavailable-reasons"');
  });
});
