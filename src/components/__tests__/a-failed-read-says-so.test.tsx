/**
 * A read that failed is told to the reader, with a way to ask again.
 *
 * A spinner means "wait", and it is the wrong thing to draw the moment the
 * answer is never coming: it asks the reader to wait forever and gives him
 * nothing to do about it. That is what a stuck screen was (bw-zkh4) — the read
 * had already failed, and the screen was still saying wait. Worse were the
 * screens that swallowed a failure into an empty list and said, confidently,
 * that there was nothing there.
 *
 * These are the panels and lists that load something. The screens with an
 * address of their own are in `src/app/__tests__/screens-that-cannot-read.test.tsx`.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const requestMock = vi.fn();
const fsListMock = vi.fn();
const fsRootsMock = vi.fn();
const fsExistsMock = vi.fn();

vi.mock('@/lib/api', () => ({
  request: (...args: unknown[]) => requestMock(...args),
  fs: {
    list: (...args: unknown[]) => fsListMock(...args),
    roots: (...args: unknown[]) => fsRootsMock(...args),
    exists: (...args: unknown[]) => fsExistsMock(...args),
  },
}));

/* eslint-disable import/first, import/order */
import { FolderBrowser } from '@/components/folder-browser';
/* eslint-enable import/first, import/order */

/** The button every one of these has to end up drawing. */
function tryAgain(): HTMLElement {
  return screen.getByRole('button', { name: /try again/i });
}

/** Nothing anywhere on the screen is still telling the reader to wait. */
function nothingIsStillSpinning(): void {
  expect(document.querySelectorAll('.animate-spin')).toHaveLength(0);
  expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
}

beforeEach(() => {
  vi.clearAllMocks();
  fsRootsMock.mockResolvedValue({ home: '/home/someone', roots: [] });
  fsExistsMock.mockResolvedValue(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a folder that could not be read', () => {
  it('says so, and reads it again when asked', async () => {
    fsListMock.mockRejectedValue(new Error('permission denied'));

    render(
      <FolderBrowser currentPath="/work" onPathChange={() => {}} onSelectPath={() => {}} />,
    );

    await screen.findByTestId('folders-error');
    expect(screen.getByText(/permission denied/)).toBeInTheDocument();
    // Not "No subdirectories found": a folder nobody could read has no count.
    expect(screen.queryByText(/no subdirectories found/i)).not.toBeInTheDocument();
    nothingIsStillSpinning();

    const askedFirst = fsListMock.mock.calls.length;
    fsListMock.mockResolvedValue([]);
    fireEvent.click(tryAgain());
    await waitFor(() => expect(fsListMock.mock.calls.length).toBeGreaterThan(askedFirst));
  });
});
