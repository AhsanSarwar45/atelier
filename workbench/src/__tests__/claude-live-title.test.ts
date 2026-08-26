/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const kit = vi.hoisted(() => ({ sessions: [] as Record<string, unknown>[] }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  listSessions: () => Promise.resolve(kit.sessions),
}));

vi.mock('../codex-thread-list.ts', () => ({
  listCodexThreads: () => Promise.resolve([]),
}));

import { knownSessions } from '../registry.ts';

describe('Claude titles in the live restore source', () => {
  beforeEach(() => {
    kit.sessions = [];
  });

  it('keeps Claude custom titles as the provider-defined conversation name', async () => {
    kit.sessions = [{
      sessionId: 'claude-custom',
      customTitle: 'Agent Defined Conversation Name',
      summary: 'the latest raw message must not replace this',
      lastModified: Date.now(),
      cwd: '/project',
    }];

    const [session] = await knownSessions('/project', true);

    expect(session!.name).toBe('Agent Defined Conversation Name');
  });

  it('does not mistake Claude summary text for an agent-defined title', async () => {
    kit.sessions = [{
      sessionId: 'claude-summary',
      summary: "currently we don't have ability to close a session in this chat. fix that.",
      firstPrompt: 'an older opening prompt',
      lastModified: Date.now(),
      cwd: '/project',
    }];

    const [session] = await knownSessions('/project', true);

    expect(session!.name).toBe("Don't Ability Close Session Chat Fix");
  });

  it('gives a short fallback to a Claude chat whose entire summary is hello', async () => {
    kit.sessions = [{
      sessionId: 'claude-hello',
      summary: 'hello',
      firstPrompt: 'hello',
      lastModified: Date.now(),
      cwd: '/project',
    }];

    const [session] = await knownSessions('/project', true);

    expect(session!.name).toBe('Hello');
  });
});
