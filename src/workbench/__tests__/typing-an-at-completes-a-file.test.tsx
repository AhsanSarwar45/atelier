/**
 * Typing `@` in the composer offers the files of the checkout (bw-gr8y.7).
 *
 * These drive a real CodeMirror view with the real extension in it, because
 * almost everything that could go wrong here is wiring: a menu that never
 * opens, one that opens on an email address, one that re-sorts the server's
 * ranking, or one whose Enter is eaten by the chat's Enter-sends. The server
 * itself is answered for by `mention.search`, which is mocked — what it ranks
 * is pinned in `server/src/routes/fs.rs` and `server/src/workbench/mention.rs`.
 *
 * The same menu offers cards, chats and skills beside the files (bw-mi3s.4).
 */
import { currentCompletions, startCompletion } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FsFoundPath, MentionOffer } from '@/lib/api';
import { ComposerEditor } from '@/workbench/composer-editor';
import { mentionCompletions } from '@/workbench/composer-files';

const search = vi.hoisted(() => vi.fn());
const names = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  mention: { search, names },
}));

const CHECKOUT = '/home/somebody/dev/beads-web';

/** Where the chat is, as the chat tab tells the menu. */
const place = (cwd: string) => ({ cwd, project: '/home/somebody/dev/beads-web', projectId: 'p1', session: 'me' });

/** What the server would answer, in the order it would answer it. */
function answers(...entries: (FsFoundPath | MentionOffer)[]) {
  search.mockResolvedValue({
    items: entries.map((entry) =>
      'path' in entry ? { kind: 'file', id: entry.path, label: entry.path, folder: entry.kind === 'dir' } : entry,
    ),
  });
}

/** What the menu asked the server for. */
const asked = () => search.mock.calls.map(([where, q, limit]) => [where.cwd, q, limit]);

/** A composer with the `@` menu in it, holding `value`, cursor at the end. */
async function aComposer(value: string, root = CHECKOUT) {
  const drawn = render(
    <ComposerEditor
      value={value}
      onChange={() => {}}
      onKey={() => false}
      onFiles={() => {}}
      extra={mentionCompletions(() => place(root))}
    />,
  );
  const editor = await waitFor(() => {
    const found = drawn.container.querySelector('.cm-editor');
    expect(found).not.toBeNull();
    return EditorView.findFromDOM(found as HTMLElement)!;
  });
  return { ...drawn, editor };
}

/**
 * Open the menu and wait for what it settles on.
 *
 * The view is focused first because CodeMirror only draws a completion tooltip
 * for an editor somebody is writing in, and the wait is a poll rather than a
 * count of ticks: the source is a fetch, and the panel is redrawn a frame after
 * the answer lands.
 */
async function menuOf(editor: EditorView, expecting = 1) {
  act(() => {
    editor.focus();
    startCompletion(editor);
  });
  if (expecting === 0) {
    // Nothing is meant to be offered, so there is no arrival to wait for; give
    // the source every chance to have run and asked anyway.
    await act(async () => {
      await new Promise((done) => setTimeout(done, 120));
    });
    return currentCompletions(editor.state);
  }
  await waitFor(() => expect(currentCompletions(editor.state).length).toBe(expecting));
  return currentCompletions(editor.state);
}

beforeEach(() => {
  search.mockReset();
  names.mockReset().mockResolvedValue({ items: [] });
});

describe('typing @ in the composer', () => {
  it('searches the folder the chat runs in for what was typed after the @', async () => {
    answers({ path: 'src/workbench/git-view.tsx', kind: 'file' });
    const { editor } = await aComposer('Look at @git-v');

    await menuOf(editor);

    expect(asked()).toContainEqual([CHECKOUT, 'git-v', 20]);
  });

  it('shows the name, the folder it is in, and the icon the file tree draws', async () => {
    answers(
      { path: 'src/workbench/git-view.tsx', kind: 'file' },
      { path: 'docs/designs', kind: 'dir' },
    );
    const { editor } = await aComposer('@git-v');

    const menu = await menuOf(editor, 2);

    expect(menu[0]!.displayLabel).toBe('git-view.tsx');
    expect(menu[0]!.detail).toBe('src/workbench');
    expect(menu[0]!.type).toBe('file');
    // A folder says so twice: with a slash after its name and as its kind.
    expect(menu[1]!.displayLabel).toBe('designs/');
    expect(menu[1]!.detail).toBe('docs');
    expect(menu[1]!.type).toBe('folder');

    // The picture is the material icon, the same one `file-icon.tsx` picks for
    // the same name, so one file does not wear two faces in one window.
    const drawn = await waitFor(() => {
      const icon = document.querySelector('.cm-tooltip-autocomplete img.cm-fileIcon');
      expect(icon).not.toBeNull();
      return icon as HTMLImageElement;
    });
    expect(drawn.getAttribute('data-icon')).toBe('react_ts');
  });

  it('keeps the server’s order instead of ranking the answer again', async () => {
    // The server put the basename hit first and the shorter path ahead of the
    // longer one. CodeMirror’s own filter would have preferred neither.
    answers(
      { path: 'src/paths.ts', kind: 'file' },
      { path: 'src/deep/nested/again/paths.ts', kind: 'file' },
      { path: 'docs/paths/notes.md', kind: 'file' },
    );
    const { editor } = await aComposer('@paths');

    const menu = await menuOf(editor, 3);

    expect(menu.map((option) => option.label)).toEqual([
      '@src/paths.ts',
      '@src/deep/nested/again/paths.ts',
      '@docs/paths/notes.md',
    ]);
  });

  it('says nothing about an @ inside a word, so an email address is left alone', async () => {
    answers({ path: 'src/a.ts', kind: 'file' });
    const { editor } = await aComposer('mail me@example.com');

    expect(await menuOf(editor, 0)).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it('inserts the reference in our own grammar, and draws it as a badge', async () => {
    answers({ path: 'src/workbench/git-view.tsx', kind: 'file' });
    const { editor, container } = await aComposer('Look at @git-v');

    const menu = await menuOf(editor);
    act(() => {
      (menu[0]!.apply as (view: EditorView, c: unknown, from: number, to: number) => void)(
        editor,
        menu[0]!,
        'Look at '.length,
        editor.state.doc.length,
      );
    });

    expect(editor.state.doc.toString()).toBe('Look at @src/workbench/git-view.tsx');
    // Which is to say: the thing the transcript already draws for the same
    // reference appears the moment it is picked (bw-gr8y.6).
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="composer-reference"]')?.getAttribute('data-reference'),
      ).toBe('src/workbench/git-view.tsx'),
    );
  });

  it('ends a folder with a slash and opens the menu again, narrowed into it', async () => {
    answers({ path: 'docs/designs', kind: 'dir' });
    const { editor } = await aComposer('@des');

    const menu = await menuOf(editor);
    act(() => {
      (menu[0]!.apply as (view: EditorView, c: unknown, from: number, to: number) => void)(
        editor,
        menu[0]!,
        0,
        editor.state.doc.length,
      );
    });

    expect(editor.state.doc.toString()).toBe('@docs/designs/');

    // The slash is what narrows: the next search is for the place, not a name,
    // and it is asked for without him touching a key.
    answers({ path: 'docs/designs/one.md', kind: 'file' });
    await waitFor(() => expect(asked().at(-1)).toEqual([CHECKOUT, 'docs/designs/', 20]));
  });

  it('offers nothing at all when the chat has no folder to search yet', async () => {
    answers({ path: 'src/a.ts', kind: 'file' });
    const { editor } = await aComposer('@a', '');

    expect(await menuOf(editor, 0)).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it('leaves the writing alone when the search fails', async () => {
    search.mockRejectedValue(new Error('no such checkout'));
    const { editor } = await aComposer('@a');

    expect(await menuOf(editor, 0)).toEqual([]);
    expect(editor.state.doc.toString()).toBe('@a');
  });
});

describe('typing @ offers Atelier’s own things beside the files', () => {
  const CHAT = '0b8f6c1e-2d3a-4f5b-9c7d-1e2f3a4b5c6d';

  it('groups them by kind under a heading each, in the order the server sent', async () => {
    answers(
      { kind: 'skill', id: 'standup', label: 'Standup', detail: 'Write the standup' },
      { kind: 'bead', id: 'bw-1', label: 'Fix the login page', detail: 'bw-1', status: 'open' },
      { path: 'src/standup.ts', kind: 'file' },
      { kind: 'chat', id: CHAT, label: 'Standup notes', brand: 'claude', projectId: 'p2' },
    );
    const { editor } = await aComposer('@stand');

    const menu = await menuOf(editor, 4);

    expect(menu.map((option) => option.label)).toEqual(['@skill:standup', '@bead:bw-1', '@src/standup.ts', `@chat:${CHAT}`]);
    const sections = menu.map((option) => option.section as { name: string; rank: number });
    expect(sections.map((section) => section.name)).toEqual(['Skills', 'Cards', 'Files', 'Chats']);
    expect(sections.map((section) => section.rank)).toEqual([0, 1, 2, 3]);
    // Each line wears the badge picking it will write.
    await waitFor(() => expect(document.querySelectorAll('[data-testid="mention-option-badge"]').length).toBe(3));
    const badges = [...document.querySelectorAll('[data-testid="mention-option-badge"]')];
    expect(badges.map((badge) => badge.getAttribute('data-reference-kind'))).toEqual(['skill', 'bead', 'chat']);
    expect(badges[2]!.textContent).toBe('Standup notes');
  });

  it('asks for only one kind when the kind is typed before a colon', async () => {
    answers({ kind: 'chat', id: CHAT, label: 'Standup notes', brand: 'claude', projectId: 'p2' });
    const { editor } = await aComposer('@chat:stan');

    await menuOf(editor);

    // The server narrows it; the menu passes the words through as typed.
    expect(asked()).toContainEqual([CHECKOUT, 'chat:stan', 20]);
  });

  it('writes the reference and draws its badge with the name the menu showed', async () => {
    answers({ kind: 'chat', id: CHAT, label: 'Standup notes', brand: 'codex', projectId: 'p2' });
    const { editor, container } = await aComposer('Compare with @stan');

    const menu = await menuOf(editor);
    act(() => {
      (menu[0]!.apply as (view: EditorView, c: unknown, from: number, to: number) => void)(
        editor,
        menu[0]!,
        'Compare with '.length,
        editor.state.doc.length,
      );
    });

    expect(editor.state.doc.toString()).toBe(`Compare with @chat:${CHAT} `);
  });

  it('cancels the question a newer keystroke has made stale', async () => {
    const signals: AbortSignal[] = [];
    search.mockImplementation((_where, _q, _limit, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise(() => {});
    });
    const { editor } = await aComposer('@st');
    act(() => {
      editor.focus();
      startCompletion(editor);
    });
    await waitFor(() => expect(signals.length).toBe(1));
    act(() => {
      editor.dispatch({ changes: { from: editor.state.doc.length, insert: 'a' }, selection: { anchor: 4 } });
    });
    await waitFor(() => expect(signals[0]!.aborted).toBe(true));
  });
});
