/**
 * The screens with an address of their own, when the thing they went to fetch
 * never came back.
 *
 * Each one of them used to end a failed read somewhere the reader could do
 * nothing with: a spinner that never stopped, a coloured line with no way to
 * ask again, an empty list where the truth was that nobody had answered, or —
 * on the project screen — a set of tabs sitting over a blank body. All of them
 * now end in the same place: what could not be read, what the machine said, and
 * a button that asks again (bw-zkh4).
 *
 * The panels and lists that load something are in
 * `src/components/__tests__/a-failed-read-says-so.test.tsx`.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const useProjectsMock = vi.fn();
vi.mock('@/hooks/use-projects', () => ({ useProjects: () => useProjectsMock() }));

const useProjectMock = vi.fn();
vi.mock('@/hooks/use-project', () => ({ useProject: () => useProjectMock() }));

const useBoardCardsMock = vi.fn();
vi.mock('@/app/project/board-cards', () => ({
  BoardCards: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useBoardCards: () => useBoardCardsMock(),
}));

const getTagsMock = vi.fn();
vi.mock('@/lib/db', () => ({
  getTags: () => getTagsMock(),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
}));

// The shell opens the window's one connection through the status chip, and the
// question here is what a screen draws — not what it is connected to.
vi.mock('@/workbench/globals', () => ({ WorkbenchStatus: () => null }));
vi.mock('@/components/shell', () => ({
  Shell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabTools: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Toolbar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const replaceMock = vi.fn();
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('id=p1'),
  useRouter: () => ({ push: vi.fn(), replace: replaceMock, back: vi.fn() }),
}));

/* eslint-disable import/first, import/order */
import ProjectsPage from '@/app/page';
import KanbanBoard from '@/app/project/kanban-board';
import SettingsPage from '@/app/settings/page';
/* eslint-enable import/first, import/order */

function tryAgain(): HTMLElement {
  return screen.getByRole('button', { name: /try again/i });
}

/** Nothing anywhere on the screen is still telling the reader to wait. */
function nothingIsStillSpinning(): void {
  expect(document.querySelectorAll('.animate-spin')).toHaveLength(0);
  expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
}

const noCards = {
  beads: [],
  ticketNumbers: new Map(),
  isLoading: false,
  error: null,
  refresh: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the list of projects', () => {
  it('says the projects could not be read, and reads them again when asked', async () => {
    const refetch = vi.fn();
    useProjectsMock.mockReturnValue({
      projects: [],
      isLoading: false,
      loadingStatus: null,
      error: new Error('the server did not answer'),
      showArchived: false,
      addProject: vi.fn(),
      updateProjectTags: vi.fn(),
      refetch,
      archiveProject: vi.fn(),
      unarchiveProject: vi.fn(),
      deleteProject: vi.fn(),
      toggleShowArchived: vi.fn(),
    });

    render(<ProjectsPage />);

    expect(screen.getByTestId('projects-error')).toBeInTheDocument();
    expect(screen.getByText(/could not be read/i)).toBeInTheDocument();
    expect(screen.getByText(/the server did not answer/)).toBeInTheDocument();
    // Not "No projects yet": a list nobody could read is not an empty one.
    expect(screen.queryByText(/no projects yet/i)).not.toBeInTheDocument();
    nothingIsStillSpinning();

    fireEvent.click(tryAgain());
    expect(refetch).toHaveBeenCalled();
  });
});

describe('the board', () => {
  it('says the project could not be read, and reads it again when asked', async () => {
    const refetch = vi.fn();
    useProjectMock.mockReturnValue({
      project: null,
      isLoading: false,
      error: new Error('no such project'),
      refetch,
    });
    useBoardCardsMock.mockReturnValue(noCards);

    render(<KanbanBoard />);

    expect(screen.getByTestId('project-error')).toBeInTheDocument();
    expect(screen.getByText(/no such project/)).toBeInTheDocument();
    nothingIsStillSpinning();

    fireEvent.click(tryAgain());
    expect(refetch).toHaveBeenCalled();
  });

  it('says the cards could not be read, and reads them again when asked', async () => {
    const refresh = vi.fn();
    useProjectMock.mockReturnValue({
      project: { id: 'p1', name: 'Atelier', path: '/work/atelier', localPath: null, tags: [] },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    useBoardCardsMock.mockReturnValue({
      ...noCards,
      error: new Error('the board file could not be read'),
      refresh,
    });

    render(<KanbanBoard />);

    expect(screen.getByTestId('board-error')).toBeInTheDocument();
    expect(screen.getByText(/the board file could not be read/)).toBeInTheDocument();
    nothingIsStillSpinning();

    fireEvent.click(tryAgain());
    expect(refresh).toHaveBeenCalled();
  });
});

describe('the settings screen', () => {
  it('says the tags could not be read rather than that there are none', async () => {
    getTagsMock.mockRejectedValue(new Error('the server did not answer'));

    render(<SettingsPage />);

    await screen.findByTestId('tags-error');
    expect(screen.getByText(/the server did not answer/)).toBeInTheDocument();
    expect(screen.queryByText(/no tags yet/i)).not.toBeInTheDocument();
    nothingIsStillSpinning();

    getTagsMock.mockResolvedValue([]);
    fireEvent.click(tryAgain());

    await waitFor(() => expect(screen.getByText(/no tags yet/i)).toBeInTheDocument());
    expect(screen.queryByTestId('tags-error')).not.toBeInTheDocument();
  });
});
