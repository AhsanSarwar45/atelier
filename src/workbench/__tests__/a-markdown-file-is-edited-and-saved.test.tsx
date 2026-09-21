/**
 * A markdown file is a file you write, not only one you read (bw-tzg0.1).
 *
 * Every other text file in the Files tab came with a pencil, a dirty dot and a
 * Save; a `.md` file came with neither, because its kind sent it down the
 * read-only preview branch instead of the viewer. A reader who opened their own
 * notes to fix a typo had to leave the app to do it.
 *
 * So markdown goes through the viewer like the rest of the text, and the
 * rendered reading it already had is a switch away — with the words on that
 * side being the ones being typed, not the ones still on disk.
 */
import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { previewKind, viewerDraws } from '@/workbench/file-preview';
import { FileViewer } from '@/workbench/file-viewer';
import { forgetUnsaved } from '@/workbench/unsaved-files';

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
const PATH = `${ROOT}/docs/notes.md`;
const SOURCE = '# Notes\n\nOne line.\n';

const readAs = (text: string, sha: string) => ({ kind: 'text' as const, text, size: text.length, sha256: sha });

function mounted(text = SOURCE, sha = 'sha-one') {
  return render(<FileViewer root={ROOT} path={PATH} file={readAs(text, sha)} />);
}

/** The editor's whole document, as the DOM has it. */
function shown(container: HTMLElement): string {
  return [...container.querySelectorAll('.cm-content .cm-line')].map((line) => line.textContent).join('\n');
}

async function toSource(view: ReturnType<typeof mounted>) {
  fireEvent.click(view.getByTestId('file-preview-source'));
  await waitFor(() => expect(view.container.querySelector('.cm-editor')).not.toBeNull());
}

/** Type one character at the editor, the way a reader's keyboard would. */
function typeInto(container: HTMLElement, key: string) {
  const content = container.querySelector('.cm-content');
  if (!content) throw new Error('there is no editor to type into');
  fireEvent.keyDown(content, { key });
}

beforeEach(() => {
  forgetUnsaved();
  mocked.write.mockReset();
  mocked.read.mockReset();
  mocked.write.mockResolvedValue({ sha256: 'sha-two', size: 1, mtime: 1 });
});

describe('a markdown file in the Files tab', () => {
  it('is drawn by the viewer, which is the half of the tab that can save', () => {
    expect(previewKind('/p/README.md')).toBe('markdown');
    expect(viewerDraws(previewKind('/p/README.md'))).toBe(true);
    expect(viewerDraws(previewKind('/p/main.ts'))).toBe(true);
    // A picture and a PDF still belong to the preview: there is nothing to type.
    expect(viewerDraws(previewKind('/p/shot.png'))).toBe(false);
    expect(viewerDraws(previewKind('/p/paper.pdf'))).toBe(false);
  });

  it('opens rendered, the way it was read before', () => {
    const view = mounted();
    expect(view.getByTestId('file-preview-markdown')).toHaveTextContent('Notes');
    expect(view.container.querySelector('.cm-editor')).toBeNull();
  });

  it('hands over its source, and takes a keystroke into it', async () => {
    const view = mounted();
    await toSource(view);
    expect(shown(view.container)).toBe(SOURCE);

    typeInto(view.container, 'x');
    await waitFor(() => expect(view.getByTestId('file-viewer-dirty')).toBeTruthy());
    expect(shown(view.container)).toBe(`x${SOURCE}`);
  });

  it('puts the typing back on disk against the digest it was read at', async () => {
    const view = mounted();
    await toSource(view);
    typeInto(view.container, 'x');
    await waitFor(() => expect(view.getByTestId('file-viewer-dirty')).toBeTruthy());

    fireEvent.click(view.getByTestId('file-viewer-save'));
    await waitFor(() => expect(mocked.write).toHaveBeenCalledWith(PATH, `x${SOURCE}`, 'sha-one'));
  });

  it('reaches the source in one press of the pencil', () => {
    const view = mounted();
    fireEvent.click(view.getByTestId('file-viewer-edit'));
    expect(view.container.querySelector('.cm-editor')).not.toBeNull();
  });

  it('renders the words being typed, not the ones still on disk', async () => {
    const view = mounted('# Notes\n');
    await toSource(view);
    typeInto(view.container, 'Z');
    await waitFor(() => expect(view.getByTestId('file-viewer-dirty')).toBeTruthy());

    fireEvent.click(view.getByTestId('file-preview-preview'));
    await waitFor(() => expect(view.getByTestId('file-preview-markdown')).toHaveTextContent('Z'));
  });
});
