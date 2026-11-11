import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const watched: Array<{ repo: string; tell: () => void }> = [];
vi.mock('@/workbench/live-wire', async (original) => ({
  ...(await original<typeof import('@/workbench/live-wire')>()),
  onWorkbench: () => () => {},
  onRepository: (repo: string, tell: () => void) => {
    const entry = { repo, tell };
    watched.push(entry);
    return () => { watched.splice(watched.indexOf(entry), 1); };
  },
}));
const list = vi.fn(async () => []);
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  tasks: { list: (...args: unknown[]) => list(...(args as [])) },
}));

import { useTasks } from '@/workbench/tasks/use-tasks';

afterEach(() => { vi.useRealTimers(); list.mockClear(); });

describe('Merged follows a merge', () => {
  it('reads the tasks again when the repository changes', async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useTasks('p1', null, '/repo'));
    await act(async () => { await vi.runAllTimersAsync(); });
    const before = list.mock.calls.length;
    expect(watched.map((w) => w.repo)).toEqual(['/repo']);
    act(() => { watched[0].tell(); watched[0].tell(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(list.mock.calls.length).toBe(before + 1);
    unmount();
    expect(watched).toHaveLength(0);
  });

  it('watches nothing without a repository', () => {
    renderHook(() => useTasks('p1'));
    expect(watched).toHaveLength(0);
  });
});
