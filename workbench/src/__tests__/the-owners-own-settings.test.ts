/**
 * @vitest-environment node
 *
 * A chat opens on what the owner already set, and what he picks is kept
 * (bw-7ks.23).
 *
 * The fault these were written against: every chat the app started was handed
 * the literal `default` — ask about every tool — and handing it over explicitly
 * beat the owner's own `permissions.defaultMode`, which on his machine says
 * bypass. So a machine configured once still opened every new chat asking about
 * everything, and the header picker was the only way out, one chat at a time
 * (bw-b1o1).
 *
 * These run against real files in a temporary directory, because the thing
 * under test IS which file wins and which file a change lands in — a stubbed
 * reader would only prove the stub.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readOwnerSettings, writeOwnerSetting } from '../owner-settings.ts';

/** The owner's config directory and one project, both thrown away afterwards. */
let config: string;
let project: string;
let hadConfigDir: string | undefined;

const write = (path: string, bag: unknown) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(bag, null, 2), 'utf8');
};
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

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

describe('where a setting he picks is kept', () => {
  it('goes to his own settings when it is kept nowhere yet', () => {
    writeOwnerSetting(project, { permissionMode: 'bypassPermissions' });

    expect(read(his())).toEqual({ permissions: { defaultMode: 'bypassPermissions' } });
    expect(readOwnerSettings(project).permissionMode).toBe('bypassPermissions');
  });

  it('goes to the project file when that is the file holding it', () => {
    write(his(), { permissions: { defaultMode: 'default' } });
    write(theProject(), { permissions: { defaultMode: 'plan' } });

    writeOwnerSetting(project, { permissionMode: 'acceptEdits' });

    expect(readOwnerSettings(project).permissionMode).toBe('acceptEdits');
    expect(read(theProject())).toEqual({ permissions: { defaultMode: 'acceptEdits' } });
    // His own is left exactly as it was: the value he sees comes from the
    // project's file, and writing under it would change nothing he can see.
    expect(read(his())).toEqual({ permissions: { defaultMode: 'default' } });
  });

  it('goes to this copy when that is the file holding it', () => {
    write(his(), { permissions: { defaultMode: 'default' } });
    write(theProject(), { permissions: { defaultMode: 'plan' } });
    write(thisCopy(), { permissions: { defaultMode: 'plan' } });

    writeOwnerSetting(project, { permissionMode: 'bypassPermissions' });

    expect(readOwnerSettings(project).permissionMode).toBe('bypassPermissions');
    expect(read(thisCopy())).toEqual({ permissions: { defaultMode: 'bypassPermissions' } });
    expect(read(theProject())).toEqual({ permissions: { defaultMode: 'plan' } });
  });

  it('leaves every other setting in the file alone', () => {
    write(his(), {
      model: 'opus',
      env: { CLAUDE_CODE_TMPDIR: '/tmp/x' },
      permissions: { allow: ['Bash(ls)'], defaultMode: 'default' },
    });

    writeOwnerSetting(project, { permissionMode: 'plan' });

    expect(read(his())).toEqual({
      model: 'opus',
      env: { CLAUDE_CODE_TMPDIR: '/tmp/x' },
      permissions: { allow: ['Bash(ls)'], defaultMode: 'plan' },
    });
  });

  it('keeps a model he picks, and takes the key out again when he picks the brand default', () => {
    writeOwnerSetting(project, { model: 'sonnet' });
    expect(readOwnerSettings(project).model).toBe('sonnet');

    write(theProject(), { model: 'haiku' });
    writeOwnerSetting(project, { model: null });

    // Out of BOTH his files: one left behind is the same as not having picked it.
    expect(readOwnerSettings(project).model).toBeNull();
    expect(read(his()).model).toBeUndefined();
    expect(read(theProject()).model).toBeUndefined();
  });
});
