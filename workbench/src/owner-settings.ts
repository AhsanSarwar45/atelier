/**
 * The settings the owner already keeps for his coding agent, read from where he
 * keeps them (bw-7ks.23).
 *
 * Read and never written. This file used to write his picks back too, so the
 * chat after the one he picked in opened on them, and he asked for that to stop:
 * "every new chat should start on the plain default, whatever I picked last."
 * The writing was also doing harm he had not asked for — a pick landed in his
 * own global file, the one every terminal on the machine reads, and a chat with
 * no model of its own then resolved one out of that same moving file and took
 * on a pick made somewhere else (bw-7ojj, sessions.ts `pin`).
 *
 * Until this file existed the app answered the two questions a chat opens on —
 * which model, and whether it asks before it touches anything — out of its own
 * head: `DEFAULT_PERMISSION_MODE`, the literal `default`, handed to the kit on
 * every start, adopt and resume. Handing it over EXPLICITLY is what made it a
 * fault rather than a coincidence: an explicit mode beats `permissions.
 * defaultMode` in the owner's own settings, so a machine configured to skip
 * every permission check still opened every new chat asking about every tool,
 * and the only way out was the header picker, one chat at a time (bw-b1o1).
 *
 * **The files, and which one wins.** These are the tool's own, in its own
 * order, lowest first — the same order its command line reads them in:
 *
 * | where | file |
 * |---|---|
 * | the owner's | `<config>/settings.json` — `CLAUDE_CONFIG_DIR`, else `~/.claude` |
 * | the project's | `<project>/.claude/settings.json` |
 * | this copy's | `<project>/.claude/settings.local.json` |
 * | the company's | the managed file, if an install has one |
 *
 * The company's file is the one an owner is not meant to be able to talk his way
 * out of, and it sits at the top for that reason.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { claudeConfigDir } from './running.ts';

/** What a chat opens on, as the owner's settings answer it. */
export interface OwnerSettings {
  /** The `model` key: an alias like `opus`, or a full model id. */
  model: string | null;
  /** The `permissions.defaultMode` key, in the kit's own spelling. */
  permissionMode: string | null;
}

/** One file the answer can come from. */
export interface SettingsLayer {
  /** Which of the four this is, for a message a person has to read. */
  name: 'the owner’s own settings' | 'this project’s settings' | 'this copy’s settings' | 'the company’s settings';
  path: string;
}

/**
 * The company-wide file, where an install has one.
 *
 * Read-only and usually absent; an ordinary machine has nothing at these paths
 * and the pile is the other three.
 */
function managedSettingsPath(): string {
  if (process.platform === 'darwin') {
    return '/Library/Application Support/ClaudeCode/managed-settings.json';
  }
  if (process.platform === 'win32') {
    return join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'ClaudeCode', 'managed-settings.json');
  }
  return '/etc/claude-code/managed-settings.json';
}

/** The four files, lowest precedence first. */
export function settingsLayers(projectPath: string): SettingsLayer[] {
  return [
    { name: 'the owner’s own settings', path: join(claudeConfigDir(), 'settings.json') },
    { name: 'this project’s settings', path: join(projectPath, '.claude', 'settings.json') },
    { name: 'this copy’s settings', path: join(projectPath, '.claude', 'settings.local.json') },
    { name: 'the company’s settings', path: managedSettingsPath() },
  ];
}

type Bag = Record<string, unknown>;

/**
 * One file's contents, or nothing.
 *
 * A file that is missing and a file that is half-written both answer nothing:
 * the sidecar serves every chat on the machine and must not fall over because
 * one of them was saved mid-edit. What it does say is which file was unreadable,
 * once, on the way past.
 */
function readLayer(path: string): Bag | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Bag) : undefined;
  } catch {
    console.warn(`[workbench] ignoring ${path}: it is not readable as settings`);
    return undefined;
  }
}

/** The `permissions.defaultMode` key of one file, if it holds one worth having. */
function modeOf(bag: Bag | undefined): string | null {
  const perms = bag?.permissions;
  if (!perms || typeof perms !== 'object') return null;
  const mode = (perms as Bag).defaultMode;
  return typeof mode === 'string' && mode ? mode : null;
}

/** The `model` key of one file, if it holds one worth having. */
function modelOf(bag: Bag | undefined): string | null {
  const model = bag?.model;
  return typeof model === 'string' && model ? model : null;
}

/** What the whole pile says, once the higher files have had their say. */
export function readOwnerSettings(projectPath: string): OwnerSettings {
  const answer: OwnerSettings = { model: null, permissionMode: null };
  for (const layer of settingsLayers(projectPath)) {
    const bag = readLayer(layer.path);
    answer.model = modelOf(bag) ?? answer.model;
    answer.permissionMode = modeOf(bag) ?? answer.permissionMode;
  }
  return answer;
}
