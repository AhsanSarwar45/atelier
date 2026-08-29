import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const params = new URLSearchParams('id=keystone&tab=board&card=never-read');
const replace = vi.fn();

vi.mock('next/navigation', () => ({
  useSearchParams: () => params,
  useRouter: () => ({ push: vi.fn(), replace, back: vi.fn() }),
}));
vi.mock('@/hooks/use-project', () => ({ useProject: () => ({
  project: {
    id: 'keystone', name: 'Keystone', path: '/dev/keystone', localPath: null,
    tags: [], usesBeads: false,
  },
  error: null,
  refetch: vi.fn(),
}) }));
vi.mock('@/workbench/chat-tab', () => ({ default: () => <div data-testid="chat-tab" /> }));
vi.mock('@/app/project/kanban-board', () => ({ default: () => <div data-testid="board" /> }));
vi.mock('@/app/project/board-cards', () => ({
  BoardCards: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/card-panel', () => ({ CardPanel: () => <div data-testid="card-panel" /> }));
vi.mock('@/components/project-settings-dialog', () => ({ ProjectSettingsDialog: () => null }));
vi.mock('@/workbench/globals', () => ({ WorkbenchStatus: () => null }));
vi.mock('@/components/shell', () => ({
  Shell: ({ tabs, children }: { tabs?: React.ReactNode; children: React.ReactNode }) => <div>{tabs}{children}</div>,
}));

import ProjectPage from '@/app/project/page';

describe('a chat-only project', () => {
  it('names the open project in the browser tab', async () => {
    const view = render(<ProjectPage />);

    await waitFor(() => expect(document.title).toBe('Keystone | Atelier'));
    view.unmount();
    expect(document.title).toBe('Atelier');
  });

  it('shows chat only and repairs a stale board address without mounting board readers', async () => {
    render(<ProjectPage />);

    expect(screen.getByTestId('chat-tab')).toBeVisible();
    expect(screen.queryByRole('tab', { name: 'Board' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('board')).not.toBeInTheDocument();
    expect(screen.queryByTestId('card-panel')).not.toBeInTheDocument();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/project?id=keystone&tab=chat'));
  });
});
