/**
 * Which Claude Code the helper drives.
 *
 * The rule has to hold on a machine it is not running on: a Windows reader's
 * copy is `claude.exe`, an Apple or Linux reader's is a plain file, and the
 * answer has to be the same shape either way. So every case here hands the
 * rule a machine rather than asking the one the test is on.
 */
import { describe, expect, it } from 'vitest';

import { claudeProgram, NAMED } from '../claude-program.ts';

/** A machine where exactly these paths are programs that run. */
const only = (...paths: string[]) => (path: string) => paths.includes(path);

describe('the Claude Code the helper drives', () => {
  it('is the one the reader named, whatever else is on the machine', () => {
    const said = claudeProgram(
      { [NAMED]: '/opt/mine/claude', PATH: '/usr/bin' },
      'linux',
      only('/usr/bin/claude', '/opt/mine/claude'),
    );
    expect(said).toBe('/opt/mine/claude');
  });

  it('is the one the reader named even when that one does not run, so a wrong path says so', () => {
    const said = claudeProgram({ [NAMED]: '/opt/gone/claude', PATH: '/usr/bin' }, 'linux', only('/usr/bin/claude'));
    expect(said).toBe('/opt/gone/claude');
  });

  it('is the first one on the path when the reader named none', () => {
    const said = claudeProgram(
      { PATH: ['/home/me/.local/bin', '/usr/bin'].join(':') },
      'linux',
      only('/home/me/.local/bin/claude', '/usr/bin/claude'),
    );
    expect(said).toBe('/home/me/.local/bin/claude');
  });

  it('skips a folder on the path that has no Claude Code in it', () => {
    const said = claudeProgram({ PATH: ['/empty', '/usr/bin'].join(':') }, 'linux', only('/usr/bin/claude'));
    expect(said).toBe('/usr/bin/claude');
  });

  it('finds a Windows reader’s copy by the ending Windows runs it under', () => {
    const said = claudeProgram(
      { Path: ['C:\\bin', 'C:\\Users\\me\\AppData\\Local\\claude'].join(';') },
      'win32',
      only('C:\\Users\\me\\AppData\\Local\\claude\\claude.exe'),
    );
    expect(said).toBe('C:\\Users\\me\\AppData\\Local\\claude\\claude.exe');
  });

  it('never answers with whatever is in the folder the helper happens to be standing in', () => {
    // An empty entry in PATH means the working directory. A chat runs in the
    // project the reader picked, and a file called `claude` sitting in one of
    // their repositories is not Claude Code.
    const said = claudeProgram({ PATH: ['', '/usr/bin'].join(':') }, 'linux', (path) => path.endsWith('claude'));
    expect(said).toBe('/usr/bin/claude');
  });

  it('answers with nothing when the machine has none, so the kit falls back to its own', () => {
    expect(claudeProgram({ PATH: '/usr/bin' }, 'linux', () => false)).toBeUndefined();
    expect(claudeProgram({}, 'linux', () => true)).toBeUndefined();
  });

  it('answers with nothing when the name the reader set is blank', () => {
    expect(claudeProgram({ [NAMED]: '   ', PATH: '/nowhere' }, 'linux', () => false)).toBeUndefined();
  });
});
