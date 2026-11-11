/**
 * `@task` in the composer (docs/tasks.md, "Front end"): a "New task" line at
 * the top of the `@` menu while what is typed could still be `task`, which
 * writes a bare `@task `; and `@task:N`, a task of the project, offered under
 * its own tab and drawn as a badge like every other reference.
 *
 * What the server ranks is pinned in `server/src/workbench/mention.rs`; what
 * the agent is told is pinned in `server/src/workbench/references.rs`.
 */
import { currentCompletions, startCompletion, type Completion } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MarkdownBody } from '@/components/markdown-body';
import { referenceLabel } from '@/components/reference-badge';
import type { MentionOffer } from '@/lib/api';
import { ComposerEditor } from '@/workbench/composer-editor';
import { mentionCompletions, offersNewTask } from '@/workbench/composer-files';
import { openableIn, type Piece } from '@/workbench/mentions';
import { forgetReferenceNames, useDescribeReference } from '@/workbench/reference-names';
import { findAtelierReferences, formatAtelierReference } from '@/workbench/references';

const search = vi.hoisted(() => vi.fn());
const names = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  mention: { search, names },
}));

const CHECKOUT = '/home/somebody/dev/beads-web';
const place = () => ({ cwd: CHECKOUT, project: CHECKOUT, projectId: 'p1', session: 'me' });

function answers(...entries: MentionOffer[]) {
  search.mockResolvedValue({ items: entries });
}

const NO_COMMANDS: never[] = [];

/** The composer as the chat draws it: the `@` menu, and badges named the way the chat names them. */
function Composer({ value, extra }: { value: string; extra: ReturnType<typeof mentionCompletions> }) {
  const describe = useDescribeReference(NO_COMMANDS);
  return <ComposerEditor value={value} onChange={() => {}} onKey={() => false} onFiles={() => {}} extra={extra} describe={describe} />;
}

async function aComposer(value: string) {
  const extra = mentionCompletions(place);
  const drawn = render(<Composer value={value} extra={extra} />);
  const editor = await waitFor(() => {
    const found = drawn.container.querySelector('.cm-editor');
    expect(found).not.toBeNull();
    return EditorView.findFromDOM(found as HTMLElement)!;
  });
  return { ...drawn, editor };
}

async function menuOf(editor: EditorView, expecting: number) {
  act(() => {
    editor.focus();
    startCompletion(editor);
  });
  if (expecting === 0) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 120));
    });
    return currentCompletions(editor.state);
  }
  await waitFor(() => expect(currentCompletions(editor.state).length).toBe(expecting));
  return currentCompletions(editor.state);
}

function pick(editor: EditorView, option: Completion, from: number) {
  act(() => {
    (option.apply as (view: EditorView, c: unknown, from: number, to: number) => void)(editor, option, from, editor.state.doc.length);
  });
}

beforeEach(() => {
  search.mockReset();
  names.mockReset().mockResolvedValue({ items: [] });
  forgetReferenceNames();
});

describe('the New task line of the @ menu', () => {
  it('is offered while what is typed is the start of "task", under All or Tasks only', () => {
    for (const typed of ['', 't', 'ta', 'TAS', 'task']) expect(offersNewTask(typed, 'all')).toBe(true);
    expect(offersNewTask('', 'task')).toBe(true);
    for (const typed of ['tasks', 'x', 'task:1']) expect(offersNewTask(typed, 'all')).toBe(false);
    expect(offersNewTask('', 'file')).toBe(false);
  });

  it('comes first, above everything the server found, and wears the badge it writes', async () => {
    answers({ kind: 'file', id: 'src/tasks.ts', label: 'tasks.ts', folder: false });
    const { editor } = await aComposer('@ta');

    const menu = await menuOf(editor, 2);

    expect(menu.map((option) => option.label)).toEqual(['@task', '@src/tasks.ts']);
    expect(menu[0]!.section).toBeUndefined();
    await waitFor(() => expect(document.querySelector('[data-testid="mention-option-badge"]')).not.toBeNull());
    const badge = document.querySelector('[data-testid="mention-option-badge"]')!;
    expect(badge.getAttribute('data-reference-kind')).toBe('task');
    expect(badge.textContent).toBe('New task');
  });

  it('is offered for a bare @, and still when the search fails', async () => {
    search.mockRejectedValue(new Error('restarting'));
    const { editor } = await aComposer('@');

    const menu = await menuOf(editor, 1);

    expect(menu[0]!.label).toBe('@task');
  });

  it('is not offered once what is typed is something else', async () => {
    answers({ kind: 'file', id: 'src/a.ts', label: 'a.ts', folder: false });
    const { editor } = await aComposer('@a');

    const menu = await menuOf(editor, 1);

    expect(menu.map((option) => option.label)).toEqual(['@src/a.ts']);
  });

  it('writes a bare @task and a space, drawn at once as its badge', async () => {
    answers();
    const { editor, container } = await aComposer('Fix the login loop @t');

    const menu = await menuOf(editor, 1);
    pick(editor, menu[0]!, 'Fix the login loop '.length);

    expect(editor.state.doc.toString()).toBe('Fix the login loop @task ');
    await waitFor(() =>
      expect(container.querySelector('.cm-content [data-reference-kind="task"]')?.textContent).toBe('New task'),
    );
  });
});

describe('a task of the project, @task:N', () => {
  const TASK: MentionOffer = { kind: 'task', id: '12', label: 'Speed up the board', detail: 'in progress', status: 'in_progress', projectId: 'p1' };

  it('is offered under its own heading with its number, title and status, and written as @task:N', async () => {
    answers(TASK);
    const { editor, container } = await aComposer('see @task:1');

    const menu = await menuOf(editor, 1);

    expect(menu[0]!.label).toBe('@task:12');
    expect((menu[0]!.section as { name: string }).name).toBe('Tasks');
    expect(menu[0]!.detail).toBe('in progress');
    expect(search.mock.calls.at(-1)![1]).toBe('task:1');
    await waitFor(() => expect(document.querySelector('[data-testid="mention-option-badge"]')).not.toBeNull());
    const badge = document.querySelector('[data-testid="mention-option-badge"]')!;
    expect(badge.textContent).toBe('#12 Speed up the board');
    expect(badge.getAttribute('data-task-status')).toBe('in_progress');

    pick(editor, menu[0]!, 'see '.length);
    expect(editor.state.doc.toString()).toBe('see @task:12 ');
    await waitFor(() =>
      expect(container.querySelector('.cm-content [data-reference-kind="task"]')?.textContent).toBe('#12 Speed up the board'),
    );
  });

  it('lights the Tasks tab when task: is typed', async () => {
    answers(TASK);
    const { editor } = await aComposer('@task:');

    await menuOf(editor, 1);

    await waitFor(() => {
      const lit = document.querySelector('[data-testid="mention-tab"][aria-selected="true"]');
      expect(lit?.textContent).toBe('Tasks');
    });
  });

  it('asks the server about a task nobody here has seen', async () => {
    await aComposer('about @task:7 again');
    await waitFor(() => expect(names).toHaveBeenCalled());
    expect(names.mock.calls[0]![1]).toEqual(['task:7']);
  });
});

describe('@task in a sent message', () => {
  it('is read as a reference: a bare one with no id, a numbered one with its number', () => {
    expect(findAtelierReferences('@task make the board faster and see @task:3')).toEqual([
      { kind: 'task', id: '', start: 0, end: 5, run: false },
      { kind: 'task', id: '3', start: 36, end: 43, run: false },
    ]);
    expect(formatAtelierReference('task', '')).toBe('@task');
    expect(formatAtelierReference('task', '3')).toBe('@task:3');
  });

  it('is split out as a badge piece and labelled', () => {
    const pieces = openableIn('@task make it faster', { cwd: CHECKOUT, home: '' }, { real: () => false });
    expect(pieces[0]).toEqual<Piece>({ kind: 'reference', ref: 'task', id: '' });
    expect(referenceLabel({ kind: 'task', id: '' })).toBe('New task');
    expect(referenceLabel({ kind: 'task', id: '4', title: null })).toBe('#4');
  });

  it('is drawn as a badge in the transcript', () => {
    render(
      <MarkdownBody
        mentions={{
          split: (text) => openableIn(text, { cwd: CHECKOUT, home: '' }, { real: () => false }),
          reference: (kind, id) => <span data-testid={`drawn-${kind}`}>{referenceLabel(kind === 'task' ? { kind, id } : { kind: 'skill', id, name: null })}</span>,
        }}
      >
        @task make the board faster
      </MarkdownBody>,
    );
    expect(screen.getByTestId('drawn-task').textContent).toBe('New task');
  });
});
