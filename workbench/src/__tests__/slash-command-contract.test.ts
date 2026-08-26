import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

import { ClaudeDriver } from '../drivers/claude.ts';
import { CODEX_SLASH_COMMANDS, CodexDriver } from '../drivers/codex.ts';
import { advertisedSlashCommands, commandExecution, offeredSlashCommand, slashInvocation } from '../drivers/slash-commands.ts';

describe('the provider-neutral slash-command contract', () => {
  it('parses one leading command and leaves ordinary prompts alone', () => {
    expect(slashInvocation('/review look at permissions')).toEqual({ name: 'review', argument: 'look at permissions' });
    expect(slashInvocation('explain /review')).toBeNull();
    expect(slashInvocation('/nested/name')).toBeNull();
  });

  it('rejects unknown commands instead of prompting the model', () => {
    expect(() => offeredSlashCommand('/typo', CODEX_SLASH_COMMANDS)).toThrow('/typo is not available');
  });

  it('normalizes old menu records while current providers declare execution explicitly', () => {
    expect(commandExecution({ name: 'old', description: '', kind: 'command' })).toBe('native');
    expect(commandExecution({ name: 'old-skill', description: '', kind: 'skill' })).toBe('skill');
    expect(CODEX_SLASH_COMMANDS.every((command) => command.execution)).toBe(true);
  });
});

describe('every advertised Codex command', () => {
  it.each(CODEX_SLASH_COMMANDS)('executes /$name through its declared $execution path', async (command) => {
    const calls: string[] = [];
    const events: any[] = [];
    const driver = new CodexDriver() as any;
    driver.threadId = 'thread';
    driver.emit = (event: any) => events.push(event);
    driver.call = async (method: string) => {
      calls.push(method);
      if (method === 'account/rateLimits/read') return { rateLimits: {} };
      if (method === 'thread/read') return { thread: { status: { type: 'idle' } } };
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      return {};
    };

    const argument = command.name === 'review' ? 'check the command contract'
      : command.name === 'model' ? 'gpt-test'
        : command.name === 'permissions' ? 'never'
          : '';
    await driver.send({ text: `/${command.name}${argument ? ` ${argument}` : ''}`, images: [] });

    if (command.name === 'model') expect(driver.model).toBe('gpt-test');
    else if (command.name === 'permissions') expect(driver.mode).toBe('never');
    else if (command.execution === 'native') expect(calls.length).toBeGreaterThan(0);
    else expect(events.some((event) => event.type === 'note')).toBe(true);
  });

  it('rejects an unadvertised slash command without starting a turn', async () => {
    const driver = new CodexDriver() as any;
    driver.threadId = 'thread';
    driver.emit = () => {};
    driver.call = async () => { throw new Error('must not call provider'); };
    await expect(driver.send({ text: '/does-not-exist', images: [] })).rejects.toThrow('not available');
  });
});

describe('Claude command discovery uses the same contract', () => {
  it('marks every dynamically advertised command and skill with an execution path', () => {
    const commands = advertisedSlashCommands([
      { name: 'compact', description: 'Compact' },
      { name: 'beads', description: 'Track work' },
      { name: 'terminal-only', description: 'Needs a TTY' },
    ], ['beads'], new Set(['terminal-only']));
    expect(commands).toEqual([
      { name: 'compact', description: 'Compact', argumentHint: undefined, kind: 'command', execution: 'native' },
      { name: 'beads', description: 'Track work', argumentHint: undefined, kind: 'skill', execution: 'skill' },
    ]);
  });

  it('executes every real discovered command through Claude', async () => {
    const commands = advertisedSlashCommands([
      { name: 'compact', description: 'Compact' },
      { name: 'beads', description: 'Track work' },
    ], ['beads']);
    for (const command of commands) {
      const driver = new ClaudeDriver() as any;
      driver.commands = commands;
      driver.menuReady = Promise.resolve();
      driver.emit = () => {};
      await driver.send({ text: `/${command.name}`, images: [] });
      expect(driver.inbox).toEqual([{ text: `/${command.name}`, images: [] }]);
    }
  });

  it('rejects an unadvertised command before it reaches Claude', async () => {
    const driver = new ClaudeDriver() as any;
    driver.commands = [{ name: 'compact', description: '', kind: 'command', execution: 'native' }];
    driver.menuReady = Promise.resolve();
    await expect(driver.send({ text: '/typo', images: [] })).rejects.toThrow('/typo is not available');
    expect(driver.inbox).toEqual([]);
  });
});
