import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Project } from '@/types';

const getProjectsWithTagsMock = vi.fn();

vi.mock('@/lib/db', () => ({
  getProjectsWithTags: (...args: unknown[]) => getProjectsWithTagsMock(...args),
  createProject: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  projects: {
    archive: vi.fn(),
    unarchive: vi.fn(),
    delete: vi.fn(),
  },
}));

// Import AFTER mocks so the hook picks them up.
// eslint-disable-next-line import/first, import/order
import { useProjects } from '../use-projects';

beforeEach(() => {
  getProjectsWithTagsMock.mockReset();
});

describe('useProjects', () => {
  it('lists the projects the server holds', async () => {
    const project: Project = {
      id: 'p1',
      name: 'Keystone',
      path: '/dev/keystone',
      tags: [],
      lastOpened: '2026-04-22T00:00:00Z',
      createdAt: '2026-04-22T00:00:00Z',
    };
    getProjectsWithTagsMock.mockResolvedValueOnce([project]);

    const { result } = renderHook(() => useProjects());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.projects).toEqual([project]);
    expect(result.current.error).toBeNull();
  });
});
