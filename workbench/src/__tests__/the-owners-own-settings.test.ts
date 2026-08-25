/**
 * @vitest-environment node
 *
 * A chat opens on what the owner already set (bw-7ks.23).
 *
 * The fault these were written against: every chat the app started was handed
 * the literal `default` — ask about every tool — and handing it over explicitly
 * beat the owner's own `permissions.defaultMode`, which on his machine says
 * bypass. So a machine configured once still opened every new chat asking about
 * everything, and the header picker was the only way out, one chat at a time
 * (bw-b1o1).
 *
 * These run against real files in a temporary directory, because the thing
 * under test IS which file wins — a stubbed reader would only prove the stub.
 *
 * The cases about where a pick was WRITTEN went with the writing itself: he
 * asked for a new chat to start on the plain default rather than on his last
 * pick, so nothing in the app writes to these files any more (bw-7ojj). That
 * nothing does is pinned where the picking happens, in
 * `a-chat-keeps-its-own-model.test.ts`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readOwnerSettings } from '../owner-settings.ts';

/** The owner's config directory and one project, both thrown away afterwards. */
let config: string;
let project: string;
let hadConfigDir: string | undefined;

const write = (path: string, bag: unknown) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(bag, null, 2), 'utf8');
};

const his = () => join(config, 'settings.json');
const theProject = () => join(project, '.claude', 'settings.json');
const thisCopy = () => join(project, '.claude', 'settings.local.json');

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'owner-settings-'));
  config = join(root, 'config');
  project = join(root, 'project');
  mkdirSync(config, { recursive: true });
  mkdirSync(join(project, '.claude'), { recursive: true });
  hadConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
});

afterEach(() => {
  if (hadConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = hadConfigDir;
  rmSync(join(config, '..'), { recursive: true, force: true });
});

describe('what a chat opens on', () => {
  it('is nothing at all when he has set nothing', () => {
    expect(readOwnerSettings(project)).toEqual({ model: null, permissionMode: null });
  });

  it('is the mode and the model his own settings name', () => {
    write(his(), { model: 'opus', permissions: { defaultMode: 'bypassPermissions' } });

    expect(readOwnerSettings(project)).toEqual({ model: 'opus', permissionMode: 'bypassPermissions' });
  });

  it('takes the project over him, and this copy over the project', () => {
    write(his(), { model: 'opus', permissions: { defaultMode: 'bypassPermissions' } });
    write(theProject(), { permissions: { defaultMode: 'plan' } });
    write(thisCopy(), { model: 'sonnet' });

    expect(readOwnerSettings(project)).toEqual({ model: 'sonnet', permissionMode: 'plan' });
  });

  // The sidecar serves every chat on the machine; one file saved mid-edit is
  // not allowed to be the end of all of them.
  it('reads past a file that is not readable as settings', () => {
    write(his(), { permissions: { defaultMode: 'acceptEdits' } });
    writeFileSync(theProject(), '{ this is half a file', 'utf8');

    expect(readOwnerSettings(project).permissionMode).toBe('acceptEdits');
  });
});
