/**
 * A search opened inside a project starts in that project (bw-c1ti.1).
 *
 * The board and the files were always searched where you stood; the chats were
 * not, so the common search — this project's chats — was the one that took the
 * most typing. The project is now already in the box when the panel opens. It
 * is in the box, not hidden behind it: the Project menu reads it back, and
 * deleting the word searches every project again.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SearchPanel } from '@/workbench/search-panel';

const listed = vi.fn();

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/api', () => ({
  projects: { list: () => listed() },
  request: () => Promise.resolve({ ok: false, status: 503 }),
}));

const shown = async () => {
  await act(async () => {
    render(<SearchPanel projectId="p1" projectPath="/home/owner/dev/beads-web" onClose={() => {}} />);
  });
  return waitFor(() => screen.getByTestId('search-input') as HTMLInputElement);
};

describe('the chats search opens where you are standing', () => {
  it('has the project in the box, and the Project menu reads it back', async () => {
    listed.mockResolvedValue([
      { id: 'p1', name: 'beads-web' },
      { id: 'p2', name: 'something else' },
    ]);
    const box = await shown();
    expect(box.value).toBe('project:beads-web ');
    expect(screen.getByTestId('search-filter-project')).toHaveTextContent('beads-web');
  });

  it('quotes a project whose name has a space', async () => {
    listed.mockResolvedValue([{ id: 'p1', name: 'beads web' }]);
    const box = await shown();
    expect(box.value).toBe('project:"beads web" ');
  });

  it('falls back to the folder when the projects cannot be listed', async () => {
    listed.mockRejectedValue(new Error('no answer'));
    const box = await shown();
    expect(box.value).toBe('project:beads-web ');
  });

  it('searches every project once the word is deleted', async () => {
    listed.mockResolvedValue([{ id: 'p1', name: 'beads-web' }]);
    const box = await shown();
    await act(async () => {
      fireEvent.change(box, { target: { value: '' } });
    });
    expect(box.value).toBe('');
    expect(screen.getByTestId('search-filter-project')).toHaveTextContent('Project');
    expect(screen.getByTestId('search-tips')).toBeTruthy();
  });

  it('starts empty when no project is being looked at', async () => {
    listed.mockResolvedValue([{ id: 'p1', name: 'beads-web' }]);
    await act(async () => {
      render(<SearchPanel projectId={null} projectPath={null} onClose={() => {}} />);
    });
    const box = await waitFor(() => screen.getByTestId('search-input') as HTMLInputElement);
    expect(box.value).toBe('');
  });
});
