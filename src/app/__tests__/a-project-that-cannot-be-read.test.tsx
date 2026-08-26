/**
 * The project screen when the project itself could not be read.
 *
 * Everything under the tabs — the board and card panel — is
 * mounted only once the project is in hand, so a failed read left the reader
 * looking at a row of tabs over an empty body: no word about what happened, and
 * nothing to press (bw-zkh4). The tabs are still there; what fills the body now
 * is the failure and a way to ask again.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const useProjectMock = vi.fn();
vi.mock('@/hooks/use-project', () => ({ useProject: () => useProjectMock() }));

// The tabs' contents are the point of the other tests, not of this one; what is
// being asked here is what the screen puts in front of the reader when there is
// no project for any of them to draw.
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
  Shell: ({ bar, tabs, children }: { bar: React.ReactNode; tabs: React.ReactNode; children: React.ReactNode }) => (
    <div>
      {bar}
      {tabs}
      {children}
    </div>
  ),
  TabTools: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Toolbar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('id=p1'),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

// eslint-disable-next-line import/first
import ProjectPage from '@/app/project/page';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the project screen', () => {
  it('says the project could not be read, instead of tabs over nothing', () => {
    const refetch = vi.fn();
    useProjectMock.mockReturnValue({
      project: null,
      isLoading: false,
      error: new Error('the server did not answer'),
      refetch,
    });

    render(<ProjectPage />);

    expect(screen.getByTestId('project-error')).toBeInTheDocument();
    expect(screen.getByText(/could not be read/i)).toBeInTheDocument();
    expect(screen.getByText(/the server did not answer/)).toBeInTheDocument();
    // The body used to hold nothing at all, and still does not hold a tab.
    expect(screen.queryByTestId('board')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-tab')).not.toBeInTheDocument();
    expect(document.querySelectorAll('.animate-spin')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it('draws the tab as usual once the project reads', () => {
    useProjectMock.mockReturnValue({
      project: { id: 'p1', name: 'Atelier', path: '/work/atelier', localPath: null, tags: [] },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    render(<ProjectPage />);

    expect(screen.getByTestId('board')).toBeInTheDocument();
    expect(screen.queryByTestId('project-error')).not.toBeInTheDocument();
  });
});
