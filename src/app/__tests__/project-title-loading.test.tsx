import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ProjectLayout from '@/app/project/layout';
import { rememberProjectName } from '@/lib/project-title';

const route = vi.hoisted(() => ({ query: 'id=project-1&tab=board' }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(route.query),
}));
vi.mock('@/hooks/use-project', () => ({ useProject: () => ({
  project: null,
  isLoading: true,
  error: null,
  refetch: vi.fn(),
}) }));
describe('the project layout title while the project is loading', () => {
  beforeEach(() => {
    window.localStorage.clear();
    rememberProjectName('project-1', 'Aspen');
  });

  it('keeps naming the project while child screens change underneath it', async () => {
    const view = render(<ProjectLayout><div>Board</div></ProjectLayout>);
    await waitFor(() => expect(document.title).toBe('Aspen | Atelier'));

    document.title = 'Atelier';
    route.query = 'id=project-1&tab=chat&chat=one';
    view.rerender(<ProjectLayout><div>Chat</div></ProjectLayout>);
    await waitFor(() => expect(document.title).toBe('Aspen | Atelier'));
  });
});
