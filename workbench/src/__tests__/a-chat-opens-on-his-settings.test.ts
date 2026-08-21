/**
 * @vitest-environment node
 *
 * The whole way through: what the app hands the kit when a chat starts, and
 * what lands in his settings when he picks something in the header (bw-7ks.23).
 *
 * The unit above this one — the-owners-own-settings.test.ts — proves which file
 * wins and which file a change goes to. These prove the two ends are actually
 * wired to it: that a chat is STARTED on what those files say rather than on the
 * literal this app used to invent (bw-b1o1), and that a picked mode is not left
 * inside the one chat that picked it.
 *
 * The driver is stubbed at its own seam — the one call that would launch a real
 * agent process — so what is asserted is the options the app hands it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const settings = () => JSON.parse(readFileSync(his(), 'utf8')) as { model?: string; permissions?: { defaultMode?: string } };

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

describe('a setting he picks in the header', () => {
  it('is kept, so the NEXT chat opens on it too', async () => {
    writeFileSync(his(), JSON.stringify({ permissions: { defaultMode: 'default' } }), 'utf8');
    const first = await startOne();

    await sessions.pin(first.id, { mode: 'bypassPermissions' });

    expect(settings().permissions?.defaultMode).toBe('bypassPermissions');
    const second = await startOne();
    expect(handed[1]?.permissionMode).toBe('bypassPermissions');
    expect(second.permissionMode).toBe('bypassPermissions');
  });

  it('keeps a model the same way, and clears it when he picks the brand default', async () => {
    const chat = await startOne();

    await sessions.pin(chat.id, { model: 'sonnet' });
    expect(settings().model).toBe('sonnet');

    await sessions.pin(chat.id, { model: 'default' });
    expect(settings().model).toBeUndefined();
  });
});
