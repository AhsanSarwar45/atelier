/**
 * Which Claude Code the helper drives.
 *
 * The kit ships its own copy — a third of a gigabyte per platform, in an
 * optional package it resolves by name — and left to itself that is what it
 * runs. Two things are wrong with that here. The product carries the helper
 * inside a single binary, and nothing that size is going in it; and the copy
 * the kit ships is pinned to the kit's own release, so a reader who updated
 * Claude Code yesterday would still be talking to whichever one was current
 * when this kit was published.
 *
 * So the helper drives the reader's own. It is the one they signed into, the
 * one their settings and skills belong to, and the one they update.
 *
 * Falling back to nothing is deliberate: handing the kit `undefined` is how it
 * is asked to resolve its own copy, which is right on a machine that installed
 * the helper from source with its optional packages. A reader with neither is
 * told so by the kit, in its own words, naming the option to set.
 */
import { accessSync, constants } from 'node:fs';
import { posix, win32, type PlatformPath } from 'node:path';

/** What a reader sets to name a Claude Code that is not on their path. */
export const NAMED = 'CLAUDE_CODE_PATH';

/** The program's own name, before a platform adds anything to it. */
const PROGRAM = 'claude';

/**
 * The endings Windows will run a bare name as, in the order it tries them.
 * `PATHEXT` is the machine's own answer to that question; these are what
 * Windows ships when it has not been changed.
 */
const WINDOWS_ENDINGS = ['.exe', '.cmd', '.bat', ''];

/** Whether a path is a file this machine will run. */
export type CanRun = (path: string) => boolean;

const runnable: CanRun = (path) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The Claude Code this helper should drive, or `undefined` to let the kit
 * answer.
 *
 * `env`, `platform` and `canRun` are arguments so the rule can be tested for
 * all three kinds of machine on whichever one is running the test.
 */
export function claudeProgram(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  canRun: CanRun = runnable,
): string | undefined {
  // Named outright. Taken at their word, whether or not it runs: a path that
  // was set and is wrong should say so, not be silently replaced by another
  // program of the same name somewhere else on the machine.
  const named = env[NAMED]?.trim();
  if (named) return named;

  // The spelling of a path is the machine's, not this process's: a test for a
  // Windows reader runs on whatever machine the suite is on, and asking the
  // default `node:path` there would split on the wrong character, join with
  // the wrong slash, and call `C:\\bin` a relative path.
  const shape: PlatformPath = platform === 'win32' ? win32 : posix;
  const path = env.PATH ?? env.Path ?? '';
  const endings = platform === 'win32' ? WINDOWS_ENDINGS : [''];
  for (const dir of path.split(shape.delimiter)) {
    // An empty entry in PATH means the working directory, and what the helper
    // happens to be standing in is not where a program is looked for.
    if (!dir) continue;
    for (const ending of endings) {
      const candidate = shape.join(dir, PROGRAM + ending);
      if (shape.isAbsolute(candidate) && canRun(candidate)) return candidate;
    }
  }
  return undefined;
}
