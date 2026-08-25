/**
 * @vitest-environment node
 *
 * The whole way through: what the app hands the kit when a chat starts
 * (bw-7ks.23).
 *
 * The unit above this one — the-owners-own-settings.test.ts — proves which file
 * wins. These prove the reading end is actually wired to it: that a chat is
 * STARTED on what those files say rather than on the literal this app used to
 * invent (bw-b1o1).
 *
 * The writing end is gone. A pick used to land in his settings so the next chat
 * opened on it, and he asked for that to stop; what happens instead is pinned in
 * a-chat-keeps-its-own-model.test.ts (bw-7ojj).
 *
 * The driver is stubbed at its own seam — the one call that would launch a real
 * agent process — so what is asserted is the options the app hands it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaudeDriver } from '../drivers/claude.ts';
import { Sessions } from '../sessions.ts';
import { Store } from '../store.ts';
import type { StartOptions } from '../drivers/types.ts';

let root: string;
let config: string;
let project: string;
let hadConfigDir: string | undefined;
let store: Store;
let sessions: Sessions;
/** The options the app handed the kit, per chat started. */
let handed: StartOptions[];

const his = () => join(config, 'settings.json');

const startOne = () =>
  sessions.start({ projectId: 'p1', projectPath: project, brand: 'claude' as const });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opens-on-'));
  config = join(root, 'config');
  project = join(root, 'project');
  mkdirSync(config, { recursive: true });
  mkdirSync(project, { recursive: true });
  hadConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;

  handed = [];
  vi.spyOn(ClaudeDriver.prototype, 'start').mockImplementation(async function (this: ClaudeDriver, opts: StartOptions) {
    handed.push(opts);
  });
  vi.spyOn(ClaudeDriver.prototype, 'setMode').mockResolvedValue(undefined);
  vi.spyOn(ClaudeDriver.prototype, 'setModel').mockResolvedValue(undefined);

  store = new Store(join(root, 'workbench.db'));
  sessions = new Sessions(store);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (hadConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = hadConfigDir;
  rmSync(root, { recursive: true, force: true });
});

describe('a chat the app starts', () => {
  // The fault itself, in one line: his machine says skip every permission
  // check, and every new chat still opened asking about every tool.
  it('is handed the mode his own settings name, not the literal default', async () => {
    writeFileSync(his(), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }), 'utf8');

    const chat = await startOne();

    expect(handed[0]?.permissionMode).toBe('bypassPermissions');
    expect(chat.permissionMode).toBe('bypassPermissions');
  });

  it('is handed the model his own settings name', async () => {
    writeFileSync(his(), JSON.stringify({ model: 'opus' }), 'utf8');

    const chat = await startOne();

    expect(handed[0]?.model).toBe('opus');
    expect(chat.model).toBe('opus');
  });

  it('falls back to asking about every tool only when he has said nothing', async () => {
    const chat = await startOne();

    expect(handed[0]?.permissionMode).toBe('default');
    expect(handed[0]?.model).toBeUndefined();
    expect(chat.model).toBeNull();
  });
});
