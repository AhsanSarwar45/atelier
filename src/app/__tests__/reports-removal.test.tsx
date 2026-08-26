import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const params = new URLSearchParams('id=p1&tab=reports&report=old-page');

vi.mock('next/navigation', () => ({
  useSearchParams: () => params,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock('@/hooks/use-project', () => ({ useProject: () => ({
  project: { id: 'p1', name: 'Atelier', path: '/work/atelier', localPath: null, tags: [] },
  error: null,
  refetch: vi.fn(),
}) }));
vi.mock('@/workbench/chat-tab', () => ({ default: () => <div data-testid="chat-tab" /> }));
vi.mock('@/app/project/kanban-board', () => ({ default: () => <div data-testid="board" /> }));
vi.mock('@/app/project/board-cards', () => ({
  BoardCards: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useBoardCards: () => ({ beads: [], ticketNumbers: new Map(), isLoading: false, error: null, refresh: vi.fn() }),
}));
vi.mock('@/components/card-panel', () => ({ CardPanel: () => null }));
vi.mock('@/components/project-settings-dialog', () => ({ ProjectSettingsDialog: () => null }));
vi.mock('@/workbench/globals', () => ({ WorkbenchStatus: () => null }));
vi.mock('@/components/shell', () => ({
  Shell: ({ tabs, children }: { tabs: React.ReactNode; children: React.ReactNode }) => <div>{tabs}{children}</div>,
}));

import ProjectPage from '@/app/project/page';
import { whereFrom } from '@/lib/address';

describe('retiring reports as a destination', () => {
  it('shows only Chat and Board and sends an old report address to the board', () => {
    expect(whereFrom(params).tab).toBe('board');

    render(<ProjectPage />);

    expect(screen.getByRole('tab', { name: 'Chat' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Board' })).toBeVisible();
    expect(screen.queryByRole('tab', { name: /report/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('board')).toBeVisible();
  });
});
