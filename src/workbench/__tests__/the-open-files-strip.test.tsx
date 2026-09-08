/**
 * The strip of open files above the viewer, and the switch that decides how a
 * file is shown (bw-g3o3.14).
 *
 * Both halves are here because both are about *which* thing ends up where, and
 * a screenshot cannot tell one from another: whether the second single click
 * replaced the preview slot or grew the strip, whether a double click stopped
 * the tab being replaceable, and whether an `.svg` is drawn as a picture while
 * an `.md` is drawn as prose. The screenshots prove the previews are legible;
 * these prove they are the right ones.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { previewKind } from '@/workbench/file-preview';
import {
  NOTHING_OPEN,
  closing,
  closingCurrent,
  openFilesFrom,
  previewing,
  pinning,
  type OpenFiles,
} from '@/workbench/open-files';
import { OpenFilesStrip, tabName } from '@/workbench/open-files-strip';

const A = '/work/project/src/a.ts';
const B = '/work/project/src/b.ts';
const C = '/work/project/src/c.ts';

const paths = (state: OpenFiles) => state.files.map((file) => file.path);

describe('what the open-files strip holds', () => {
  it('gives a single click the one replaceable slot', () => {
    const first = previewing(NOTHING_OPEN, A);
    expect(paths(first)).toEqual([A]);
    expect(first.files[0]!.preview).toBe(true);
    expect(first.current).toBe(A);

    // The second glance takes the slot rather than growing the strip.
    const second = previewing(first, B);
    expect(paths(second)).toEqual([B]);
    expect(second.current).toBe(B);
  });

  it('keeps a file once it is pinned, and previews beside it', () => {
    const pinned = pinning(previewing(NOTHING_OPEN, A), A);
    expect(pinned.files[0]!.preview).toBe(false);

    const glanced = previewing(pinned, B);
    expect(paths(glanced)).toEqual([A, B]);
    // The preview slot is where the glance went, and the next one replaces it.
    expect(paths(previewing(glanced, C))).toEqual([A, C]);
  });

  it('replaces the preview in its own place, not at the end', () => {
    const state = previewing(pinning(previewing(NOTHING_OPEN, B), B), A);
    // A was glanced at after B was pinned, so it sits second.
    expect(paths(state)).toEqual([B, A]);
    expect(paths(previewing(state, C))).toEqual([B, C]);
  });

  it('shows a file that is already open without un-pinning it', () => {
    const state = previewing(pinning(NOTHING_OPEN, A), B);
    const back = previewing(state, A);
    expect(back.current).toBe(A);
    expect(back.files.find((file) => file.path === A)!.preview).toBe(false);
    expect(paths(back)).toEqual([A, B]);
  });

  it('pins a file it has never seen, which is what a double click means', () => {
    const state = pinning(NOTHING_OPEN, A);
    expect(paths(state)).toEqual([A]);
    expect(state.files[0]!.preview).toBe(false);
  });

  it('lands on the tab that took its place when the open file is closed', () => {
    const three = pinning(pinning(pinning(NOTHING_OPEN, A), B), C);
    const middle = { ...three, current: B };
    expect(closing(middle, B).current).toBe(C);
    // The last one has nothing to its right, so the reader lands to the left.
    expect(closing(three, C).current).toBe(B);
    expect(closing(pinning(NOTHING_OPEN, A), A)).toEqual(NOTHING_OPEN);
  });

  it('leaves the file being read alone when another is closed', () => {
    const two = pinning(pinning(NOTHING_OPEN, A), B);
    const closed = closing(two, A);
    expect(closed.current).toBe(B);
    expect(paths(closed)).toEqual([B]);
  });

  it('closes the one in front for Ctrl+W, and nothing when nothing is open', () => {
    const two = pinning(pinning(NOTHING_OPEN, A), B);
    expect(paths(closingCurrent(two))).toEqual([A]);
    expect(closingCurrent(NOTHING_OPEN)).toEqual(NOTHING_OPEN);
  });

  it('reads a remembered strip back, and shrugs off anything else', () => {
    expect(openFilesFrom(JSON.stringify([{ path: A, preview: true }, { path: B }]))).toEqual([
      { path: A, preview: true },
      { path: B, preview: false },
    ]);
    expect(openFilesFrom(null)).toEqual([]);
    expect(openFilesFrom('{ not json')).toEqual([]);
    expect(openFilesFrom(JSON.stringify({ files: [A] }))).toEqual([]);
    expect(openFilesFrom(JSON.stringify([{ path: 7 }, { path: A }]))).toEqual([{ path: A, preview: false }]);
  });

  it('calls a tab by the file name and not by the path to it', () => {
    expect(tabName(A)).toBe('a.ts');
    expect(tabName('bare')).toBe('bare');
  });
});

describe('the strip on screen', () => {
  const drawn = (state: OpenFiles) => {
    const handlers = {
      onPreview: vi.fn(),
      onPin: vi.fn(),
      onClose: vi.fn(),
      onCloseCurrent: vi.fn(),
    };
    render(<OpenFilesStrip state={state} {...handlers} />);
    return handlers;
  };

  it('is not there at all while nothing is open', () => {
    drawn(NOTHING_OPEN);
    expect(screen.queryByTestId('open-files-strip')).toBeNull();
  });

  it('marks the preview tab and the one being read', () => {
    drawn(previewing(pinning(NOTHING_OPEN, A), B));
    const tabs = screen.getAllByTestId('open-file');
    expect(tabs.map((tab) => tab.getAttribute('data-path'))).toEqual([A, B]);
    expect(tabs[0]!.getAttribute('data-preview')).toBeNull();
    expect(tabs[1]!.getAttribute('data-preview')).toBe('true');
    expect(tabs[1]!.getAttribute('data-current')).toBe('true');
  });

  it('previews on a click and pins on a double click', () => {
    const handlers = drawn(pinning(NOTHING_OPEN, A));
    const tab = screen.getByTestId('open-file');
    fireEvent.click(tab);
    expect(handlers.onPreview).toHaveBeenCalledWith(A);
    fireEvent.doubleClick(tab);
    expect(handlers.onPin).toHaveBeenCalledWith(A);
  });

  it('closes on the × and on a middle click, without also switching to the tab', () => {
    const handlers = drawn(pinning(NOTHING_OPEN, A));
    fireEvent.click(screen.getByTestId('open-file-close'));
    expect(handlers.onClose).toHaveBeenCalledWith(A);
    expect(handlers.onPreview).not.toHaveBeenCalled();

    // React's onAuxClick, which testing-library has no shorthand for.
    fireEvent(screen.getByTestId('open-file'), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    expect(handlers.onClose).toHaveBeenCalledTimes(2);
  });

  it('closes the one in front on Ctrl+W and on Cmd+W', () => {
    const handlers = drawn(pinning(NOTHING_OPEN, A));
    fireEvent.keyDown(window, { key: 'w', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'w', metaKey: true });
    expect(handlers.onCloseCurrent).toHaveBeenCalledTimes(2);
    // A bare w is somebody typing.
    fireEvent.keyDown(window, { key: 'w' });
    expect(handlers.onCloseCurrent).toHaveBeenCalledTimes(2);
  });

  it('offers a dot instead of a × once a file has unsaved edits', () => {
    // The seam bw-g3o3.8 fills; the strip only draws what it is handed.
    render(
      <OpenFilesStrip
        state={pinning(NOTHING_OPEN, A)}
        dirty={new Set([A])}
        onPreview={vi.fn()}
        onPin={vi.fn()}
        onClose={vi.fn()}
        onCloseCurrent={vi.fn()}
      />,
    );
    expect(screen.getByTestId('open-file-dirty')).toBeTruthy();
    expect(screen.queryByTestId('open-file-close')).toBeNull();
  });
});

describe('how a file is shown', () => {
  it('sends each kind to the view that suits it', () => {
    expect(previewKind('/p/shot.png')).toBe('image');
    expect(previewKind('/p/Photo.JPEG')).toBe('image');
    expect(previewKind('/p/logo.svg')).toBe('svg');
    expect(previewKind('/p/run.mp4')).toBe('video');
    expect(previewKind('/p/take.webm')).toBe('video');
    expect(previewKind('/p/note.mp3')).toBe('audio');
    expect(previewKind('/p/paper.pdf')).toBe('pdf');
    expect(previewKind('/p/README.md')).toBe('markdown');
  });

  it('leaves everything else to the text viewer, binaries included', () => {
    expect(previewKind('/p/main.rs')).toBe('text');
    expect(previewKind('/p/data.json')).toBe('text');
    expect(previewKind('/p/notes.txt')).toBe('text');
    expect(previewKind('/p/release.tar.gz')).toBe('text');
    expect(previewKind('/p/Makefile')).toBe('text');
  });
});
