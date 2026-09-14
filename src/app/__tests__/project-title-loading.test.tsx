import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ProjectPage from '@/app/project/page';
import { rememberProjectName } from '@/lib/project-title';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('id=project-1&tab=chat'),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock('@/hooks/use-project', () => ({ useProject: () => ({
  project: null,
  isLoading: true,
  error: null,
  refetch: vi.fn(),
}) }));
vi.mock('@/workbench/chat-tab', () => ({ default: () => <div /> }));
vi.mock('@/app/project/kanban-board', () => ({ default: () => <div /> }));
vi.mock('@/app/project/board-cards', () => ({
  BoardCards: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/card-panel', () => ({ CardPanel: () => null }));
vi.mock('@/components/project-settings-dialog', () => ({ ProjectSettingsDialog: () => null }));
vi.mock('@/workbench/globals', () => ({ WorkbenchStatus: () => null }));
vi.mock('@/components/shell', () => ({
  Shell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('a project title while the project is loading', () => {
  beforeEach(() => {
    window.localStorage.clear();
    rememberProjectName('project-1', 'Aspen');
  });

  afterEach(() => { document.title = 'Atelier'; });

  it('keeps naming the project instead of falling back to the product', async () => {
    render(<ProjectPage />);

    await waitFor(() => expect(document.title).toBe('Aspen | Atelier'));
  });
});
