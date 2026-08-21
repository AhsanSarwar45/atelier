/**
 * The settings the owner already keeps for his coding agent — read from where
 * he keeps them, and written back to the same place (bw-7ks.23).
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
 * The company's file is read and never written: it is the one an owner is not
 * meant to be able to talk his way out of.
 *
 * **Which file a change lands in.** The one the value is already kept in —
 * highest of the writable three that names the key, and the owner's own when
 * none of them does. Anything else surprises somebody: writing a project file
 * that never mentioned the key puts a personal choice in front of everyone who
 * checks the repository out, and writing under a file that overrides it writes
 * a value that never takes effect. That last one is not left to reasoning: the
 * write is read back through the whole pile afterwards, and a value that did
 * not survive the trip is an error the picker shows rather than a change the
 * owner thinks he made.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { claudeConfigDir } from './running.ts';

/** What a chat opens on, as the owner's settings answer it. */
export interface OwnerSettings {
  /** The `model` key: an alias like `opus`, or a full model id. */
  model: string | null;
  /** The `permissions.defaultMode` key, in the kit's own spelling. */
  permissionMode: string | null;
}

/** One file the answer can come from, and whether the app may write to it. */
export interface SettingsLayer {
  /** Which of the four this is, for a message a person has to read. */
  name: 'the owner’s own settings' | 'this project’s settings' | 'this copy’s settings' | 'the company’s settings';
  path: string;
  writable: boolean;
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
    { name: 'the owner’s own settings', path: join(claudeConfigDir(), 'settings.json'), writable: true },
    { name: 'this project’s settings', path: join(projectPath, '.claude', 'settings.json'), writable: true },
    { name: 'this copy’s settings', path: join(projectPath, '.claude', 'settings.local.json'), writable: true },
    { name: 'the company’s settings', path: managedSettingsPath(), writable: false },
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

/** Which of the two keys a change is about, and how each is read and written. */
const KEYS = {
  permissionMode: {
    read: modeOf,
    write: (bag: Bag, value: string | null) => {
      const perms = bag.permissions && typeof bag.permissions === 'object' ? { ...(bag.permissions as Bag) } : {};
      if (value === null) delete perms.defaultMode;
      else perms.defaultMode = value;
      if (Object.keys(perms).length) bag.permissions = perms;
      else delete bag.permissions;
    },
    said: 'permission mode',
  },
  model: {
    read: modelOf,
    write: (bag: Bag, value: string | null) => {
      if (value === null) delete bag.model;
      else bag.model = value;
    },
    said: 'model',
  },
} as const;

/** Rewrites one file, leaving every other key in it exactly as it was. */
function keep(path: string, change: (bag: Bag) => void): void {
  const bag = readLayer(path) ?? {};
  change(bag);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(bag, null, 2)}\n`, 'utf8');
}

/**
 * Puts one chosen setting where the owner keeps it, and proves it landed.
 *
 * `null` is a real choice and not an absence: it is the picker's own top row —
 * the brand's default model — and it means the key comes OUT, of every file of
 * his that holds it, because leaving one behind is the same as not having
 * picked it.
 *
 * Throws when the value it wrote is not the value the pile then reads back —
 * which is what a company-wide file overriding the choice looks like from here,
 * and the only honest answer to a picker whose change would otherwise vanish at
 * the next restart with nothing said.
 */
export function writeOwnerSetting(
  projectPath: string,
  what: { permissionMode?: string | null; model?: string | null },
): void {
  for (const key of ['permissionMode', 'model'] as const) {
    const value = what[key];
    if (value === undefined) continue;
    const { read, write, said } = KEYS[key];

    const layers = settingsLayers(projectPath);
    const writable = layers.filter((l) => l.writable);

    if (value === null) {
      for (const layer of writable) {
        if (read(readLayer(layer.path))) keep(layer.path, (bag) => write(bag, null));
      }
    } else {
      // The file it is already kept in, or his own when it is kept nowhere.
      const target = [...writable].reverse().find((l) => read(readLayer(l.path))) ?? writable[0];
      keep(target.path, (bag) => write(bag, value));
    }

    const now = readOwnerSettings(projectPath)[key];
    if (now !== value) {
      const above = layers.find((l) => !l.writable && read(readLayer(l.path)));
      throw new Error(
        `The ${said} was written to the owner's settings but ${above?.name ?? 'a file above them'} still says ${now}, so the change would not take effect.`,
      );
    }
  }
}
