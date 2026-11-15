/**
 * A project with tasks turned off shows no Tasks tab, and an address that
 * names the tab opens the chat instead.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectPage from '@/app/project/page';

const params = new URLSearchParams('id=keystone&tab=tasks');

vi.mock('next/navigation', () => ({
  useSearchParams: () => params,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock('@/hooks/use-project', () => ({ useProject: () => ({
  project: { id: 'keystone', name: 'Keystone', path: '/dev/keystone', tags: [] },
  error: null,
  refetch: vi.fn(),
}) }));
vi.mock('@/workbench/chat-tab', () => ({ default: () => <div data-testid="chat-tab" /> }));
vi.mock('@/workbench/tasks/tasks-tab', () => ({ default: () => <div data-testid="tasks-tab" /> }));
vi.mock('@/components/project-settings-screen', () => ({ ProjectSettingsScreen: () => null }));
vi.mock('@/workbench/globals', () => ({ WorkbenchStatus: () => null }));
vi.mock('@/components/shell', () => ({
  Shell: ({ tabs, children }: { tabs?: React.ReactNode; children: React.ReactNode }) => <div>{tabs}{children}</div>,
}));

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    if (String(url).includes('/api/workbench/tasks-switch')) {
      return Response.json({ install: true, project: false, enabled: false });
    }
    return Response.json([]);
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('a project with tasks turned off', () => {
  it('has no Tasks tab and opens the chat', async () => {
    render(<ProjectPage />);
    expect(await screen.findByTestId('chat-tab')).toBeVisible();
    await waitFor(() => expect(screen.queryByTestId('tab-tasks')).not.toBeInTheDocument());
    expect(screen.queryByTestId('tasks-tab')).not.toBeInTheDocument();
  });
});
