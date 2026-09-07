/**
 * Where a new chat is sent to work (bw-ov7a.2).
 *
 * A chat used to be able to work in one place only — the project's own root —
 * so a person whose work happens in worktrees had no way to say so, and the
 * chat's own chip could never name anything but the project. The command now
 * carries the directory, and this is the one decision in building it: silence
 * still means the project, so nothing changes for a project with no worktrees
 * at all.
 */
import { describe, expect, it } from 'vitest';
import { startingChat } from '@/workbench/protocol';

describe('the command that starts a chat', () => {
  it('carries the worktree the person picked', () => {
    const command = startingChat('p1', '/home/dev/app', 'claude', '/home/dev/app/worktrees/bw-1');
    expect(command).toEqual({
      type: 'session.start',
      projectId: 'p1',
      projectPath: '/home/dev/app',
      brand: 'claude',
      cwd: '/home/dev/app/worktrees/bw-1',
    });
  });

  it('carries a worktree kept beside the project as readily as one inside it', () => {
    const command = startingChat('p1', '/home/dev/app', 'codex', '/home/dev/app-worktrees/bw-1');
    expect(command.cwd).toBe('/home/dev/app-worktrees/bw-1');
  });

  it('says nothing about a folder for a chat that works in the project itself', () => {
    for (const where of [undefined, null, '', '/home/dev/app', '/home/dev/app/']) {
      const command = startingChat('p1', '/home/dev/app', 'claude', where);
      expect(command.cwd, `${where} should not be sent`).toBeUndefined();
      expect(Object.keys(command)).not.toContain('cwd');
    }
  });

  it('does not mistake the project for a worktree over a trailing slash', () => {
    expect(startingChat('p1', '/home/dev/app/', 'claude', '/home/dev/app').cwd).toBeUndefined();
  });
});
