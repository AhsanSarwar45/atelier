import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ProjectPage from '@/app/project/page';

const params = new URLSearchParams('id=keystone&tab=board&card=never-read');
const replace = vi.fn();

vi.mock('next/navigation', () => ({
  useSearchParams: () => params,
  useRouter: () => ({ push: vi.fn(), replace, back: vi.fn() }),
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
  Shell: ({ tabs, toolbar, children }: { tabs?: React.ReactNode; toolbar?: boolean; children: React.ReactNode }) => (
    <div>{toolbar ? <div data-testid="asked-for-toolbar" /> : null}{tabs}{children}</div>
  ),
}));

describe('an address saved while the board was here', () => {
  it('opens on the tasks and is rewritten without the board', async () => {
    render(<ProjectPage />);

    expect(await screen.findByTestId('tasks-tab')).toBeVisible();
    expect(screen.queryByRole('tab', { name: 'Board' })).not.toBeInTheDocument();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/project?id=keystone&tab=tasks'));
  });

  it('still asks for the bar the tabs’ own tools are drawn in', () => {
    render(<ProjectPage />);

    expect(screen.getByTestId('asked-for-toolbar')).toBeInTheDocument();
  });
});
