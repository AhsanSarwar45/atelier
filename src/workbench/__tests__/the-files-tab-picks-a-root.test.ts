import { describe, expect, it } from 'vitest';

import type { GitTree } from '@/lib/api';
import { folderName, rootsAmong, rootShown } from '@/workbench/files-tab';

/**
 * Which checkout the Files tab is reading out of (bw-g3o3.4). A project with
 * worktrees holds the same file at several paths on several branches, so a tree
 * that guessed would show a reader the wrong copy of the file they had just
 * edited. The two rules that keep it honest — the project is always offered and
 * always first, and a remembered root that has gone away falls back to it — are
 * proved here rather than on a screen.
 */
const tree = (name: string, path: string, isMain: boolean, branch: string | null): GitTree => ({
  name,
  path,
  branch,
  isMain,
  dirty: false,
  ahead: 0,
  behind: 0,
});

const main = tree('atelier', '/work/atelier', true, 'ours');
const job = tree('bw-g3o3.4', '/work/atelier/worktrees/bw-g3o3.4', false, 'bw-g3o3.4');

describe('which checkout the Files tab shows', () => {
  it('offers the project first and the worktrees after it', () => {
    expect(rootsAmong([job, main], '/work/atelier').map((root) => root.path)).toEqual([
      main.path,
      job.path,
    ]);
  });

  it('still offers the project when git said nothing about it', () => {
    const roots = rootsAmong([], '/work/atelier');
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ name: 'atelier', path: '/work/atelier', isMain: true });
  });

  it('keeps the remembered checkout while it is still there', () => {
    expect(rootShown([main, job], job.path, '/work/atelier')).toBe(job.path);
  });

  it('falls back to the project when the remembered checkout has been deleted', () => {
    expect(rootShown([main], job.path, '/work/atelier')).toBe(main.path);
    expect(rootShown([main], null, '/work/atelier')).toBe(main.path);
  });

  it('names a checkout after its own folder', () => {
    expect(folderName('/work/atelier')).toBe('atelier');
    expect(folderName('/work/atelier/')).toBe('atelier');
    expect(folderName('/')).toBe('/');
  });
});
