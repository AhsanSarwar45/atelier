/**
 * @vitest-environment node
 *
 * A chat goes on running the model it was left on, whatever another chat was
 * later set to (bw-7ojj).
 *
 * The manager: "if i change it in one chat, the other existing chat shouldn't
 * switch to that model when i switch to that chat and send a message."
 *
 * It had two halves and both are pinned here. Picking a model wrote the pick
 * into his own settings file so the next chat opened on it — and that file is
 * the global one his terminals read, so a pick in this app changed what every
 * terminal on the machine started on. Meanwhile a chat with no model of its own
 * was attached with none, which is how the kit is asked to work one out, and it
 * works it out of that same file. So the two met: every chat begun in a terminal
 * and every chat he had never picked in silently took on his latest pick the
 * first time he typed into it, and then froze there.
 *
 * The driver is stubbed at the one call that would launch a real agent, so what
 * is asserted is the model the app handed it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
/** The options the app handed the kit, per chat attached. */
let handed: StartOptions[];

const his = () => join(config, 'settings.json');
const hisSettings = () => JSON.parse(readFileSync(his(), 'utf8')) as { model?: string; permissions?: { defaultMode?: string } };

/**
 * A chat begun somewhere else, with a record of its own saying what answered
 * in it. The folder name is the kit's, and it is found by looking rather than
 * by spelling, so any name will do.
 */
function beganElsewhere(model: string | null): string {
  const externalId = randomUUID();
  const folder = join(config, 'projects', 'a-folder-the-kit-named');
  mkdirSync(folder, { recursive: true });
  const lines = [JSON.stringify({ type: 'user', message: { content: 'do the thing' } })];
  if (model) lines.push(JSON.stringify({ type: 'assistant', message: { model, content: [] } }));
  writeFileSync(join(folder, `${externalId}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
  return externalId;
}

const wakeIt = (externalId: string) =>
  sessions.resume({ externalId, brand: 'claude' as const, projectId: 'p1', projectPath: project });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'own-model-'));
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

describe('picking a model in one chat', () => {
  it('leaves the settings every other chat opens on exactly as they were', async () => {
    writeFileSync(his(), JSON.stringify({ model: 'sonnet' }), 'utf8');
    const chat = await sessions.start({ projectId: 'p1', projectPath: project, brand: 'claude' });

    await sessions.pin(chat.id, { model: 'opus' });

    expect(hisSettings().model, 'his own settings were rewritten by a pick').toBe('sonnet');
  });

  it('leaves the mode in them alone too', async () => {
    writeFileSync(his(), JSON.stringify({ permissions: { defaultMode: 'default' } }), 'utf8');
    const chat = await sessions.start({ projectId: 'p1', projectPath: project, brand: 'claude' });

    await sessions.pin(chat.id, { mode: 'bypassPermissions' });

    expect(hisSettings().permissions?.defaultMode).toBe('default');
    // The chat he picked in still changed, which is the whole point of picking.
    expect(store.getSession(chat.id)?.permissionMode).toBe('bypassPermissions');
  });

  it('does not move the chat he picked in out of the way of the next new one', async () => {
    writeFileSync(his(), JSON.stringify({ model: 'sonnet' }), 'utf8');
    const first = await sessions.start({ projectId: 'p1', projectPath: project, brand: 'claude' });
    await sessions.pin(first.id, { model: 'opus' });

    const second = await sessions.start({ projectId: 'p1', projectPath: project, brand: 'claude' });

    // What he asked for: a new chat starts on the plain default, not on the
    // last thing he happened to pick somewhere else.
    expect(handed[1]?.model).toBe('sonnet');
    expect(second.model).toBe('sonnet');
  });
});

describe('a chat woken up after a pick somewhere else', () => {
  it('comes back on the model it was left on, not on the pick', async () => {
    writeFileSync(his(), JSON.stringify({ model: 'sonnet' }), 'utf8');
    const picked = await sessions.start({ projectId: 'p1', projectPath: project, brand: 'claude' });
    await sessions.pin(picked.id, { model: 'opus' });

    // A chat this app never started and never picked in: its row holds no model
    // at all, and its own record is the only thing that knows.
    const left = beganElsewhere('claude-haiku-4-5-20260101');
    await wakeIt(left);

    const woken = handed[handed.length - 1];
    expect(woken?.model, 'it took on the model picked in another chat').toBe('claude-haiku-4-5-20260101');
  });

  it('writes that model onto its own row, so nothing is worked out for it twice', async () => {
    const left = beganElsewhere('claude-haiku-4-5-20260101');
    const woken = await wakeIt(left);

    expect(woken.model).toBe('claude-haiku-4-5-20260101');
    expect(store.getSession(woken.id)?.model).toBe('claude-haiku-4-5-20260101');
  });

  it('is still handed nothing when its record has never been answered in', async () => {
    // Nothing is known, so there is nothing to freeze and the kit works it out
    // from his settings — which is the right answer now that a pick no longer
    // moves them.
    writeFileSync(his(), JSON.stringify({ model: 'sonnet' }), 'utf8');
    const fresh = beganElsewhere(null);

    await wakeIt(fresh);

    expect(handed[handed.length - 1]?.model).toBeUndefined();
  });
});
