/**
 * The helper's records land where the app looks for them, on every machine.
 *
 * The helper used to work the folder out itself and knew only the one way a
 * Linux machine names it, so on an Apple or a Windows machine it wrote every
 * chat into a folder the app never reads (bw-8um.3.14). These cases are the
 * same rule `server/src/identity.rs` follows, one per kind of machine, so the
 * two cannot drift apart again without one of them going red.
 */
import { describe, expect, it } from 'vitest';

import { dataHome, HANDED_DOWN } from '../data-home.ts';

describe('where the helper keeps its records', () => {
  it('is whatever the app said when it started the helper, on any machine', () => {
    // The app has already asked the operating system; a helper that worked it
    // out again would be a second copy of the rule, free to drift.
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(dataHome({ [HANDED_DOWN]: '/told/where/to/write' }, platform, '/home/someone'))
        .toBe('/told/where/to/write');
    }
  });

  it('is the folder an Apple machine files a program under', () => {
    expect(dataHome({}, 'darwin', '/Users/someone')).toBe(
      '/Users/someone/Library/Application Support/com.weselow.atelier',
    );
  });

  it('is the roaming folder a Windows machine names', () => {
    expect(dataHome({ APPDATA: 'C:\\Users\\someone\\AppData\\Roaming' }, 'win32', 'C:\\Users\\someone'))
      .toBe('C:\\Users\\someone\\AppData\\Roaming/weselow/atelier/data');
  });

  it('falls back to the usual roaming folder when a Windows machine names none', () => {
    expect(dataHome({}, 'win32', '/home/someone')).toBe(
      '/home/someone/AppData/Roaming/weselow/atelier/data',
    );
  });

  it('is the data folder a Linux machine names', () => {
    expect(dataHome({ XDG_DATA_HOME: '/somewhere/data' }, 'linux', '/home/someone')).toBe(
      '/somewhere/data/atelier',
    );
  });

  it('falls back to the usual data folder when a Linux machine names none', () => {
    expect(dataHome({}, 'linux', '/home/someone')).toBe('/home/someone/.local/share/atelier');
  });

  it('never answers with the name the product used to have', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(dataHome({}, platform, '/home/someone')).not.toContain('kanban-ui');
    }
  });
});
