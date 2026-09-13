import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const chat = readFileSync('src/workbench/chat-tab.tsx', 'utf8');
const protocol = readFileSync('src/workbench/protocol.ts', 'utf8');

describe('changing account inside a chat', () => {
  it('offers the active provider accounts in both composer layouts', () => {
    expect(chat).toContain('testid="account-picker"');
    expect(chat).toContain('testid="mobile-account-picker"');
    expect(chat).toContain('sessionAccounts.length > 1');
    expect(chat).toContain("const sessionProfile = view.profile ?? 'system'");
  });

  it('changes this session rather than the new-chat default', () => {
    expect(protocol).toContain("type: 'session.profile'");
    expect(chat).toContain("sendCommand({ type: 'session.profile', sessionId, profileId })");
    expect(chat).toContain("'Wait for the current response to finish'");
  });
});
