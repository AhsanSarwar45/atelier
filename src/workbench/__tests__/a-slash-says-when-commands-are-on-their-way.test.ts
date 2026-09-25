/**
 * A chat that is not awake asks its provider what `/` commands it has the
 * first time it is opened in a folder. Until the answer comes, its menu says
 * the commands are on their way rather than that there are none (bw-zldt.2).
 */
import { describe, expect, it } from 'vitest';

import { asView, reduce } from '@/workbench/fold';
import type { WbpEvent } from '@/workbench/protocol';

describe('a slash in a chat still asking for its commands', () => {
  it('reads the wait from the snapshot, and drops it when the commands arrive', () => {
    const opened = asView({
      lastSeq: 4,
      menu: { commands: [{ name: 'skill:demo', kind: 'skill', execution: 'shared' }], commandsPending: true },
    } as never);
    expect(opened.menu.commandsPending).toBe(true);

    const answered = reduce(opened, {
      type: 'session.menu', sessionId: 'chat', seq: 5, at: 'now',
      commands: [{ name: 'compact', kind: 'command' }, { name: 'skill:demo', kind: 'skill', execution: 'shared' }],
      skills: [], models: [], permissionModes: [], agentControls: [],
    } as unknown as WbpEvent);
    expect(answered.menu.commandsPending).toBeUndefined();
    expect(answered.menu.commands.map((c) => c.name)).toEqual(['compact', 'skill:demo']);
  });

  it('is not waiting on anything unless the server says so', () => {
    expect(asView({ menu: { commandsPending: 'yes' } } as never).menu.commandsPending).toBeUndefined();
  });
});
