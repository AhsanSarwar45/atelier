/**
 * The `/` menu runs on the composer's completion engine, the same one as `@`
 * (bw-mi3s.5), and a pasted card or chat address goes in as its reference.
 *
 * A real CodeMirror view with the real extension in it, driven through both
 * doors the box has: the drawn line and the form control a machine types into.
 */
import { currentCompletions } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { ComposerEditor } from '@/workbench/composer-editor';
import { commandFeed, mentionCompletions, rankCommands } from '@/workbench/composer-files';
import type { CommandInfo } from '@/workbench/protocol';
import { referenceForAddress } from '@/workbench/references';

const COMMANDS: CommandInfo[] = [
  { name: 'compact', description: 'Shrink the conversation', kind: 'command' },
  { name: 'context', description: 'Show what the context holds', kind: 'command' },
  { name: 'status', description: 'Show the status', kind: 'command' },
  { name: 'skill:standup', title: 'Standup', description: 'Write the standup', kind: 'skill', execution: 'shared' },
];

function Box({ feed, start = '' }: { feed: ReturnType<typeof commandFeed>; start?: string }) {
  const [value, setValue] = useState(start);
  const [extra] = useState(() => mentionCompletions(() => ({ cwd: '', project: null, projectId: null, session: null }), feed));
  return <ComposerEditor value={value} onChange={setValue} onKey={() => false} onFiles={() => {}} extra={extra} />;
}

async function aBox(start = '', commands = COMMANDS, pending = false) {
  const feed = commandFeed();
  feed.set({ commands, pending });
  const drawn = render(<Box feed={feed} start={start} />);
  const editor = await waitFor(() => EditorView.findFromDOM(drawn.container.querySelector('.cm-editor') as HTMLElement)!);
  return { ...drawn, editor, feed, box: screen.getByTestId('composer') as HTMLTextAreaElement };
}

const offered = (editor: EditorView) => currentCompletions(editor.state).map((c) => c.label);

describe('the / menu', () => {
  it('ranks whole names, then starts of names or skill ids, then insides, then loose letters', () => {
    const named = (typed: string) => rankCommands(COMMANDS, typed).map((c) => c.name);
    expect(named('')).toEqual(['compact', 'context', 'status', 'skill:standup']);
    expect(named('stand')).toEqual(['skill:standup']);
    expect(named('co')).toEqual(['compact', 'context']);
    expect(named('tatu')).toEqual(['status']);
    expect(named('cmpt')).toEqual(['compact']);
    expect(named('zz')).toEqual([]);
  });

  it('opens for a slash typed into the form control, and Enter there picks', async () => {
    const { editor, box } = await aBox();
    fireEvent.change(box, { target: { value: '/co' } });
    await waitFor(() => expect(offered(editor)).toEqual(['/compact', '/context']));
    await waitFor(() => expect(document.querySelector('[data-testid="command-menu"]')).not.toBeNull());
    expect([...document.querySelectorAll('[data-testid="command-option"]')].map((o) => o.getAttribute('data-command'))).toEqual([
      'compact',
      'context',
    ]);
    // Past CodeMirror's pause before a fresh menu takes Enter.
    await act(() => new Promise((done) => setTimeout(done, 100)));
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(editor.state.doc.toString()).toBe('/compact '));
    expect(box.value).toBe('/compact ');
  });

  it('is put away by Escape and keeps what was typed', async () => {
    const { editor, box } = await aBox();
    fireEvent.change(box, { target: { value: '/compact' } });
    await waitFor(() => expect(offered(editor)).toEqual(['/compact']));
    fireEvent.keyDown(box, { key: 'Escape' });
    await waitFor(() => expect(offered(editor)).toEqual([]));
    expect(box.value).toBe('/compact');
  });

  it('says the provider’s commands are still coming, and shows them when they come', async () => {
    const { editor, box, feed } = await aBox('', [], true);
    fireEvent.change(box, { target: { value: '/' } });
    await waitFor(() => expect(document.querySelector('[data-testid="commands-pending"]')).not.toBeNull());
    act(() => feed.set({ commands: COMMANDS, pending: false }));
    await waitFor(() => expect(offered(editor)).toEqual(['/compact', '/context', '/status', '/skill:standup']));
    expect(document.querySelector('[data-testid="commands-pending"]')).toBeNull();
    expect(document.querySelector('[data-command="skill:standup"]')?.textContent).toContain('Atelier');
  });

  it('opens when the commands come after the slash, unless it was closed on that slash', async () => {
    const { editor, box, feed } = await aBox('', [], false);
    fireEvent.change(box, { target: { value: '/' } });
    await act(() => new Promise((done) => setTimeout(done, 20)));
    expect(document.querySelector('[data-testid="command-menu"]')).toBeNull();
    // An answer that is still empty comes first, and the menu that found nothing shuts itself.
    act(() => feed.set({ commands: [], pending: false }));
    await act(() => new Promise((done) => setTimeout(done, 20)));
    act(() => feed.set({ commands: COMMANDS, pending: false }));
    await waitFor(() => expect(offered(editor)).toEqual(['/compact', '/context', '/status', '/skill:standup']));

    fireEvent.keyDown(box, { key: 'Escape' });
    await waitFor(() => expect(offered(editor)).toEqual([]));
    act(() => feed.set({ commands: COMMANDS.slice(1), pending: false }));
    await act(() => new Promise((done) => setTimeout(done, 20)));
    expect(offered(editor)).toEqual([]);
  });

  it('opens for a box that starts out holding a slash', async () => {
    const { editor } = await aBox('/sta');
    await waitFor(() => expect(offered(editor)).toEqual(['/status', '/skill:standup']));
  });

  it('stays shut once the draft is more than one word', async () => {
    const { editor, box } = await aBox();
    fireEvent.change(box, { target: { value: '/compact now' } });
    await act(() => new Promise((done) => setTimeout(done, 50)));
    expect(offered(editor)).toEqual([]);
  });
});

describe('a pasted address of this app', () => {
  const HERE = 'http://127.0.0.1:3100';
  const CHAT = '0b8f6c1e-2d3a-4f5b-9c7d-1e2f3a4b5c6d';

  it('is the reference to the card or the chat it opens', () => {
    expect(referenceForAddress(`${HERE}/project?id=p1&card=bw-mi3s.5`, HERE)).toBe('@bead:bw-mi3s.5');
    expect(referenceForAddress(`${HERE}/project?id=p1&tab=chat&chat=${CHAT}`, HERE)).toBe(`@chat:${CHAT}`);
    expect(referenceForAddress(`/project?id=p1&card=bw-1`, HERE)).toBe('@bead:bw-1');
  });

  it('is left alone when it is somewhere else or something else', () => {
    expect(referenceForAddress('https://example.com/project?card=bw-1', HERE)).toBeNull();
    expect(referenceForAddress(`${HERE}/settings?section=library`, HERE)).toBeNull();
    expect(referenceForAddress(`${HERE}/project?id=p1`, HERE)).toBeNull();
    expect(referenceForAddress(`see ${HERE}/project?card=bw-1`, HERE)).toBeNull();
  });

  it('goes into the box as the reference', async () => {
    const { editor } = await aBox('Look at ');
    act(() => editor.dispatch({ selection: { anchor: editor.state.doc.length } }));
    const pasted = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    pasted.clipboardData = {
      getData: () => `${window.location.origin}/project?id=p1&card=bw-7`,
      files: [],
    };
    act(() => {
      editor.contentDOM.dispatchEvent(pasted);
    });
    expect(editor.state.doc.toString()).toBe('Look at @bead:bw-7 ');
  });
});
