import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const screen = readFileSync('src/workbench/accounts-settings.tsx', 'utf8');
const asking = readFileSync('server/src/workbench/signin.rs', 'utf8');

describe('the accounts screen', () => {
  it('asks for a name only once the person has asked to add one', () => {
    // The name box used to sit under every list, on a screen where most
    // people have one account and are not naming a second one today.
    expect(screen).toContain('data-testid="account-new-dialog"');
    expect(screen).toContain('setNaming(brand)');
    expect(screen).not.toContain('Name this ${brandName(brand)} account');
  });

  it('says nothing it can show instead', () => {
    // A dialog whose buttons are the instruction does not also need a
    // sentence describing them; the description stays for a screen reader.
    expect(screen).toContain('<DialogDescription className="sr-only">');
    expect(screen).not.toContain('Open this page and sign in to');
    expect(screen).not.toContain('Paste the code that page gave you');
  });

  it('keeps the code box behind the sentence that offers it', () => {
    // Claude's page signs the person in by itself and hands nothing back, so
    // a code box drawn up front sends them looking for a code.
    expect(screen).toContain("state === 'paste-the-code' && !typing");
    expect(screen).toContain('That page gave me a code');
  });
});

describe('who an account is signed in as', () => {
  it('asks Claude on a terminal, which is the only way it answers', () => {
    expect(asking).toContain('async fn asked_on_a_terminal');
    expect(asking).toContain('if brand == "claude" {');
  });

  it('asks the system profile with the environment left alone', () => {
    // Naming ~/.claude by hand makes Claude look for ~/.claude/.claude.json,
    // which is not where it keeps the owner's own account.
    expect(asking).toContain('pub async fn standing(brand: &str, directory: Option<&Path>)');
    expect(asking).toContain('if let Some(directory) = directory {');
  });

  it('does not read Codex’s method as a person', () => {
    expect(asking).toContain('account: None,');
    expect(asking).toContain('.map(|(_, how)| how.trim().to_string())');
  });
});
