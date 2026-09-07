/**
 * Choosing where a new chat will work (bw-ov7a.3).
 *
 * The picker offers three answers — the project, a worktree that is there, or
 * one made on the spot — and each of them has a different set of things it
 * still needs before a chat can start. What it needs is a sentence the reader
 * is shown, so it is asserted as a sentence.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { GitBranch, GitTree } from '@/lib/api';

const trees = vi.fn();
const branches = vi.fn();
vi.mock('@/lib/api', () => ({ git: { trees: (...a: unknown[]) => trees(...a), branches: (...a: unknown[]) => branches(...a) } }));

const {
  WhereToWork,
  basesAmong,
  isPlainName,
  suggestedBranch,
  whatIsMissing,
  worktreesAmong,
} = await import('@/workbench/where-to-work');
type Where = Parameters<typeof whatIsMissing>[0];

function tree(name: string, extra: Partial<GitTree> = {}): GitTree {
  return {
    name,
    path: `/home/dev/app/worktrees/${name}`,
    branch: name,
    isMain: false,
    dirty: false,
    ahead: 0,
    behind: 0,
    ...extra,
  };
}

const PROJECT = tree('app', { path: '/home/dev/app', branch: 'main', isMain: true });

function branch(name: string, isRemote = false): GitBranch {
  return { name, upstream: null, ahead: 0, behind: 0, isRemote };
}

describe('what a choice still needs', () => {
  const there = [PROJECT, tree('bw-1'), tree('bw-2')];

  it('asks nothing of the project itself', () => {
    expect(whatIsMissing({ kind: 'project' }, [])).toBeNull();
  });

  it('holds an existing worktree to being one that is really there', () => {
    expect(whatIsMissing({ kind: 'existing', path: there[1].path }, there)).toBeNull();
    expect(whatIsMissing({ kind: 'existing', path: '' }, there)).toBe('Choose a worktree.');
    expect(whatIsMissing({ kind: 'existing', path: '/gone' }, there)).toBe('Choose a worktree.');
  });

  it('wants a name for a new worktree, and one that is a folder name', () => {
    const half = (name: string): Where => ({ kind: 'new', name, branch: 'work', create: true, base: 'main' });
    expect(whatIsMissing(half('bw-3'), there)).toBeNull();
    expect(whatIsMissing(half(''), there)).toBe('Name the new worktree.');
    expect(whatIsMissing(half('  '), there)).toBe('Name the new worktree.');
    for (const bad of ['../up', 'a/b', '..', '.']) {
      expect(whatIsMissing(half(bad), there), bad).toBe("A worktree's name is one plain folder name.");
    }
  });

  it('refuses a name another worktree already has, before git has to', () => {
    const same: Where = { kind: 'new', name: 'bw-1', branch: 'work', create: true, base: 'main' };
    expect(whatIsMissing(same, there)).toBe('There is already a worktree called bw-1.');
  });

  it('says which kind of branch is missing, because they are asked for differently', () => {
    const fresh: Where = { kind: 'new', name: 'bw-3', branch: '', create: true, base: 'main' };
    expect(whatIsMissing(fresh, there)).toBe('Name the new branch.');
    expect(whatIsMissing({ ...fresh, create: false }, there)).toBe('Choose a branch.');
  });

  it('lets a branch be named the way branches really are named', () => {
    const slashed: Where = { kind: 'new', name: 'bw-3', branch: 'feature/worktrees', create: true, base: 'main' };
    expect(whatIsMissing(slashed, there)).toBeNull();
    expect(isPlainName('feature/worktrees')).toBe(false);
    expect(suggestedBranch('  bw-3  ')).toBe('bw-3');
  });
});

describe('the lists it offers', () => {
  it('never offers the project as a worktree to send a chat to', () => {
    expect(worktreesAmong([PROJECT, tree('bw-1')]).map((t) => t.name)).toEqual(['bw-1']);
  });

  it('starts a branch only from one this copy really holds', () => {
    expect(basesAmong([branch('main'), branch('origin/main', true)]).map((b) => b.name)).toEqual(['main']);
  });
});

describe('the picker on the screen', () => {
  beforeEach(() => {
    trees.mockReset();
    branches.mockReset();
    trees.mockResolvedValue({ trees: [PROJECT, tree('bw-1')], place: '/home/dev/app/worktrees' });
    branches.mockResolvedValue({ current: 'main', branches: [branch('main'), branch('origin/main', true)] });
  });

  function draw(value: Where = { kind: 'project' }) {
    const onChange = vi.fn();
    const onMissing = vi.fn();
    render(
      <WhereToWork projectPath="/home/dev/app" value={value} onChange={onChange} onMissing={onMissing} />,
    );
    return { onChange, onMissing };
  }

  it('names the project itself as one of the three ways in', async () => {
    draw();
    await waitFor(() => expect(screen.getByTestId('where-project')).toHaveTextContent('app'));
    expect(screen.getByTestId('where-existing')).toBeEnabled();
    expect(screen.getByTestId('where-new')).toBeEnabled();
  });

  it('has nothing to choose from when the project has no worktrees', async () => {
    trees.mockResolvedValue({ trees: [PROJECT], place: '/home/dev/app/worktrees' });
    draw();
    await waitFor(() => expect(screen.getByTestId('where-existing')).toBeDisabled());
    expect(
      screen.getByTestId('where-new'),
      'making the first one is exactly what this is for',
    ).toBeEnabled();
  });

  it('offers the worktree that is there when the person asks for one', async () => {
    const { onChange } = draw();
    await waitFor(() => expect(screen.getByTestId('where-existing')).toBeEnabled());
    fireEvent.click(screen.getByTestId('where-existing'));
    expect(onChange).toHaveBeenCalledWith({ kind: 'existing', path: '/home/dev/app/worktrees/bw-1' });
  });

  it('asks a new worktree for a name and a branch off the branch the project is on', async () => {
    const { onChange } = draw();
    await waitFor(() => expect(screen.getByTestId('where-new')).toBeEnabled());
    fireEvent.click(screen.getByTestId('where-new'));
    expect(onChange).toHaveBeenCalledWith({ kind: 'new', name: '', branch: '', create: true, base: 'main' });
  });

  it('lets the branch follow the name, so the ordinary case is typed once', async () => {
    const { onChange } = draw({ kind: 'new', name: '', branch: '', create: true, base: 'main' });
    await waitFor(() => expect(screen.getByTestId('where-new-name')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('where-new-name'), { target: { value: 'bw-3' } });
    expect(onChange).toHaveBeenCalledWith({ kind: 'new', name: 'bw-3', branch: 'bw-3', create: true, base: 'main' });
  });

  it('leaves a branch the person has typed alone when the name changes after it', async () => {
    const { onChange } = draw({ kind: 'new', name: 'bw', branch: 'my-own-branch', create: true, base: 'main' });
    await waitFor(() => expect(screen.getByTestId('where-new-name')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('where-new-name'), { target: { value: 'bw-3' } });
    expect(onChange).toHaveBeenCalledWith({
      kind: 'new', name: 'bw-3', branch: 'my-own-branch', create: true, base: 'main',
    });
  });

  it('swaps the branch controls for a chooser when the branch already exists', async () => {
    const { onChange } = draw({ kind: 'new', name: 'bw-3', branch: 'bw-3', create: true, base: 'main' });
    await waitFor(() => expect(screen.getByTestId('where-branch-name')).toBeInTheDocument());
    expect(screen.getByTestId('where-base')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('where-branch-existing'));
    expect(onChange).toHaveBeenCalledWith({ kind: 'new', name: 'bw-3', branch: '', create: false, base: 'main' });
  });

  it('shows the chooser and no base once that swap has been made', async () => {
    draw({ kind: 'new', name: 'bw-3', branch: '', create: false, base: 'main' });
    await waitFor(() => expect(screen.getByTestId('where-branch')).toBeInTheDocument());
    expect(screen.queryByTestId('where-branch-name')).toBeNull();
    expect(screen.queryByTestId('where-base')).toBeNull();
    expect(screen.getByTestId('where-missing')).toHaveTextContent('Choose a branch.');
  });

  it('tells the button outside it what the choice still needs', async () => {
    const { onMissing } = draw({ kind: 'new', name: '', branch: '', create: true, base: 'main' });
    await waitFor(() => expect(onMissing).toHaveBeenCalledWith('Name the new worktree.'));
  });

  it('falls back to the project, and says why, when git cannot be read', async () => {
    trees.mockRejectedValue(new Error('not a git repository'));
    draw();
    await waitFor(() =>
      expect(screen.getByTestId('where-unreadable')).toHaveTextContent('not a git repository'),
    );
    expect(screen.getByTestId('where-existing')).toBeDisabled();
  });
});
