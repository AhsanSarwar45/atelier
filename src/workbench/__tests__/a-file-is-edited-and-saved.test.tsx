/**
 * Editing a file in the viewer and putting it back on disk (bw-g3o3.8).
 *
 * These ask the document rather than the component, for the same reason the
 * reading cases do: CodeMirror owns its own DOM and builds it outside React. So
 * a keystroke here is a real keydown on the content, and what it proves is what
 * the reader would see — the file taking the character it was typed, the dot
 * appearing, the save carrying the digest the read came with, and the undo
 * still being there afterwards.
 */
import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileViewer } from '@/workbench/file-viewer';
import { forgetUnsaved, unsavedPaths } from '@/workbench/unsaved-files';

const mocked = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly body?: unknown,
    ) {
      super(message);
      this.name = 'ApiError';
    }
  }
  return {
    ApiError,
    openExternal: vi.fn().mockResolvedValue(undefined),
    write: vi.fn(),
    read: vi.fn(),
  };
});

vi.mock('@/lib/api', () => ({
  ApiError: mocked.ApiError,
  fs: { openExternal: mocked.openExternal, write: mocked.write, read: mocked.read },
}));

const ROOT = '/home/reader/project';
const PATH = `${ROOT}/src/counter.ts`;
const SOURCE = 'export const count = 1;\n';

/** A file as the read route hands it over, digest and all. */
const readAs = (text: string, sha: string) => ({
  kind: 'text' as const,
  text,
  size: text.length,
  sha256: sha,
});

/** The editor's whole document, as the DOM has it. */
function shown(container: HTMLElement): string {
  return [...container.querySelectorAll('.cm-content .cm-line')].map((line) => line.textContent).join('\n');
}

/** Type one character at the editor, the way a reader's keyboard would. */
function typeInto(container: HTMLElement, key: string) {
  const content = container.querySelector('.cm-content');
  if (!content) throw new Error('there is no editor to type into');
  fireEvent.keyDown(content, { key });
}

async function mounted(text = SOURCE, sha = 'sha-one') {
  const view = render(<FileViewer root={ROOT} path={PATH} file={readAs(text, sha)} />);
  await waitFor(() => expect(view.container.querySelector('.cm-editor')).not.toBeNull());
  return view;
}

beforeEach(() => {
  forgetUnsaved();
  mocked.write.mockReset();
  mocked.read.mockReset();
  mocked.write.mockResolvedValue({ sha256: 'sha-two', size: 1, mtime: 1 });
});

afterEach(() => {
  forgetUnsaved();
});

describe('a file the reader edits', () => {
  it('is read-only until a keystroke, which is kept rather than swallowed', async () => {
    const { container, getByTestId, queryByTestId } = await mounted();
    expect(container.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false');
    expect(queryByTestId('file-viewer-dirty')).toBeNull();

    typeInto(container, 'X');

    await waitFor(() =>
      expect(container.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('true'),
    );
    // The character that opened the file up is in the file, not lost to the flip.
    expect(shown(container)).toBe('Xexport const count = 1;\n');
    expect(getByTestId('file-viewer-dirty')).toBeTruthy();
    expect(unsavedPaths()).toEqual([PATH]);
  });

  it('can be opened for editing by the header button instead', async () => {
    const { container, getByTestId } = await mounted();
    fireEvent.click(getByTestId('file-viewer-edit'));
    await waitFor(() =>
      expect(container.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('true'),
    );
    // Opened, but nothing typed: there is nothing to save and nothing to warn about.
    expect(getByTestId('file-viewer-save')).toHaveProperty('disabled', true);
    expect(unsavedPaths()).toEqual([]);
  });

  it('saves with the digest the file was read at, and keeps the undo afterwards', async () => {
    const { container, getByTestId, queryByTestId } = await mounted();
    typeInto(container, 'X');
    await waitFor(() => expect(getByTestId('file-viewer-dirty')).toBeTruthy());

    fireEvent.keyDown(window, { key: 's', ctrlKey: true });

    await waitFor(() => expect(mocked.write).toHaveBeenCalledWith(PATH, `Xexport const count = 1;\n`, 'sha-one'));
    await waitFor(() => expect(queryByTestId('file-viewer-dirty')).toBeNull());

    // The save must not have cleared the history: the edit is still undoable.
    fireEvent.keyDown(container.querySelector('.cm-content')!, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(shown(container)).toBe(SOURCE));
  });

  it('sends the digest the last save answered with, not the one it was read at', async () => {
    const { container, getByTestId } = await mounted();
    typeInto(container, 'X');
    await waitFor(() => expect(getByTestId('file-viewer-dirty')).toBeTruthy());
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => expect(mocked.write).toHaveBeenCalledTimes(1));

    // A second edit, this time through the editor's own keymap: the file is
    // open now, so the intent handler steps aside and CodeMirror takes it.
    fireEvent.keyDown(container.querySelector('.cm-content')!, { key: 'Enter' });
    await waitFor(() => expect(getByTestId('file-viewer-dirty')).toBeTruthy());
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });

    await waitFor(() => expect(mocked.write).toHaveBeenCalledTimes(2));
    expect(mocked.write.mock.calls[1][2]).toBe('sha-two');
  });

  it('warns the window while there is unsaved work, and stops once it is saved', async () => {
    const { container, getByTestId } = await mounted();
    const asks = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(asks()).toBe(false);

    typeInto(container, 'X');
    await waitFor(() => expect(getByTestId('file-viewer-dirty')).toBeTruthy());
    expect(asks()).toBe(true);

    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => expect(unsavedPaths()).toEqual([]));
    expect(asks()).toBe(false);
  });
});

describe('a file that moved on disk', () => {
  it('is reloaded outright while nothing has been typed', async () => {
    const { container, rerender, queryByTestId } = await mounted();

    rerender(<FileViewer root={ROOT} path={PATH} file={readAs('export const count = 99;\n', 'sha-else')} />);

    await waitFor(() => expect(shown(container)).toBe('export const count = 99;\n'));
    expect(queryByTestId('file-viewer-outside')).toBeNull();
  });

  it('offers Reload and Keep rather than choosing, once something has been typed', async () => {
    const { container, getByTestId, rerender } = await mounted();
    typeInto(container, 'X');
    await waitFor(() => expect(getByTestId('file-viewer-dirty')).toBeTruthy());

    rerender(<FileViewer root={ROOT} path={PATH} file={readAs('theirs\n', 'sha-theirs')} />);

    await waitFor(() => expect(getByTestId('file-viewer-outside')).toBeTruthy());
    // Nothing was taken on its own: what the reader typed is still on screen.
    expect(shown(container)).toBe('Xexport const count = 1;\n');

    fireEvent.click(getByTestId('file-viewer-reload'));
    await waitFor(() => expect(shown(container)).toBe('theirs\n'));
    expect(unsavedPaths()).toEqual([]);
  });

  it('lets the reader keep theirs, and the next save then writes over the new file', async () => {
    const { container, getByTestId, rerender, queryByTestId } = await mounted();
    typeInto(container, 'X');
    await waitFor(() => expect(getByTestId('file-viewer-dirty')).toBeTruthy());
    rerender(<FileViewer root={ROOT} path={PATH} file={readAs('theirs\n', 'sha-theirs')} />);
    await waitFor(() => expect(getByTestId('file-viewer-outside')).toBeTruthy());

    fireEvent.click(getByTestId('file-viewer-keep'));
    await waitFor(() => expect(queryByTestId('file-viewer-outside')).toBeNull());
    expect(shown(container)).toBe('Xexport const count = 1;\n');

    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    // Their digest, deliberately: the reader was shown the other text and said
    // to write over it, so the save must not be refused a second time.
    await waitFor(() =>
      expect(mocked.write).toHaveBeenCalledWith(PATH, 'Xexport const count = 1;\n', 'sha-theirs'),
    );
  });

  it('turns a refused save into the same two choices', async () => {
    mocked.write.mockRejectedValue(new mocked.ApiError('API error: 409 stale', 409));
    mocked.read.mockResolvedValue({ kind: 'text', size: 7, mtime: 1, text: 'theirs\n', sha256: 'sha-theirs' });

    const { container, getByTestId } = await mounted();
    typeInto(container, 'X');
    await waitFor(() => expect(getByTestId('file-viewer-dirty')).toBeTruthy());

    fireEvent.keyDown(window, { key: 's', ctrlKey: true });

    await waitFor(() => expect(getByTestId('file-viewer-outside')).toBeTruthy());
    expect(getByTestId('file-viewer-save-error').textContent).toContain('changed on disk');
    fireEvent.click(getByTestId('file-viewer-reload'));
    await waitFor(() => expect(shown(container)).toBe('theirs\n'));
  });
});
