/**
 * The `@` menu opens with what is ready and fills in the rest as it arrives.
 *
 * In a folder with a great many files under it — the home folder — listing the
 * files takes a while. The server answers at once with everything else and
 * says files are still coming (`pending`), and the menu that is already open
 * asks again by itself, so the skills are there to pick straight away and the
 * files join them without another keystroke.
 */
import { currentCompletions, startCompletion } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MentionOffer } from '@/lib/api';
import { ComposerEditor } from '@/workbench/composer-editor';
import { mentionCompletions } from '@/workbench/composer-files';

const search = vi.hoisted(() => vi.fn());
const names = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  mention: { search, names },
}));

const HOME = '/home/somebody';
const place = () => ({ cwd: HOME, project: HOME, projectId: 'p1', session: 'me' });

const SKILL: MentionOffer = { kind: 'skill', id: 'standup', label: 'standup', detail: 'Write the standup' };
const FILE: MentionOffer = { kind: 'file', id: 'notes.md', label: 'notes.md' };

beforeEach(() => {
  search.mockReset();
  names.mockReset().mockResolvedValue({ items: [] });
});

describe('the @ menu in a folder whose files are still being listed', () => {
  it('opens with the skills, then adds the files without another keystroke', async () => {
    let listed = false;
    search.mockImplementation(async () =>
      listed ? { items: [FILE, SKILL] } : { items: [SKILL], pending: ['file'] },
    );
    const drawn = render(
      <ComposerEditor value="@" onChange={() => {}} onKey={() => false} onFiles={() => {}} extra={mentionCompletions(place)} />,
    );
    const editor = await waitFor(() => {
      const found = drawn.container.querySelector('.cm-editor');
      expect(found).not.toBeNull();
      return EditorView.findFromDOM(found as HTMLElement)!;
    });

    act(() => {
      editor.focus();
      startCompletion(editor);
    });
    await waitFor(() => expect(currentCompletions(editor.state).map((line) => line.label)).toContain('@skill:standup'));
    expect(currentCompletions(editor.state).map((line) => line.label)).not.toContain('@notes.md');

    listed = true;
    await waitFor(
      () => expect(currentCompletions(editor.state).map((line) => line.label)).toContain('@notes.md'),
      { timeout: 3000 },
    );
    expect(currentCompletions(editor.state).map((line) => line.label)).toContain('@skill:standup');
  });
});
