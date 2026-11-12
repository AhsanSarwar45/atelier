import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ProjectPage from '@/app/project/page';
import { whereFrom } from '@/lib/address';

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
vi.mock('@/workbench/tasks/tasks-tab', () => ({ default: () => <div data-testid="tasks-tab" /> }));
vi.mock('@/components/project-settings-screen', () => ({ ProjectSettingsScreen: () => null }));
vi.mock('@/workbench/globals', () => ({ WorkbenchStatus: () => null }));
vi.mock('@/components/shell', () => ({
  Shell: ({ tabs, children }: { tabs: React.ReactNode; children: React.ReactNode }) => <div>{tabs}{children}</div>,
}));

describe('retiring reports as a destination', () => {
  it('shows no report tab and sends an old report address to the chat', async () => {
    expect(whereFrom(params).tab).toBe('chat');

    render(<ProjectPage />);

    expect(screen.getByRole('tab', { name: 'Chat' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Tasks' })).toBeVisible();
    expect(screen.queryByRole('tab', { name: /report/i })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
  });
});
