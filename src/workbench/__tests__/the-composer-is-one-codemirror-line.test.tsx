/**
 * The writing box, now that it is a CodeMirror line rather than a textarea
 * (bw-gr8y.6).
 *
 * Two promises are being kept at once and they pull against each other. The
 * reader sees a file reference as a badge — the same badge the transcript draws
 * for the same reference — and the agent receives the characters he typed, to
 * the byte. So every case below checks both halves of the same line: what is on
 * screen, and what the document underneath still says.
 *
 * The editor owns its own DOM and builds it outside React, so these ask the
 * document rather than the component, the way the file viewer's cases do.
 */
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';

import { enterSubmits } from '@/workbench/chat-tab';
import { ComposerEditor } from '@/workbench/composer-editor';

/** The box on screen, and the editor inside it, once it has built itself. */
async function aComposer(props: Partial<React.ComponentProps<typeof ComposerEditor>> = {}) {
  const onChange = vi.fn();
  const onKey = vi.fn(() => false);
  const onFiles = vi.fn();
  const drawn = render(
    <ComposerEditor value="" onChange={onChange} onKey={onKey} onFiles={onFiles} {...props} />,
  );
  const editor = await waitFor(() => {
    const found = drawn.container.querySelector('.cm-editor');
    expect(found).not.toBeNull();
    return EditorView.findFromDOM(found as HTMLElement)!;
  });
  return { ...drawn, editor, onChange, onKey, onFiles };
}

/** What the badges say, in the order they are drawn. */
const badgesIn = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-testid="composer-reference"]')].map((badge) =>
    badge.getAttribute('data-reference'),
  );

describe('the composer', () => {
  it('draws every reference as a badge and leaves the characters underneath alone', async () => {
    const line = 'Read @src/workbench/paths.ts:12-40 and then @docs/designs/, please.';
    const { container, editor } = await aComposer({ value: line });

    expect(badgesIn(container)).toEqual(['src/workbench/paths.ts:12-40', 'docs/designs/']);
    // The whole point: the badge is a drawing of the text, not a replacement
    // for it. What `prompt.send` will carry is still exactly what was written.
    expect(editor.state.doc.toString()).toBe(line);
  });

  it('draws what another editor pasted in in OUR form, without rewriting it', async () => {
    // Claude Code's JetBrains plugin writes `#L3-L9`; the badge says what we
    // would have written, and the document still says what was pasted.
    const line = 'Look at @src/a.ts#L3-L9';
    const { container, editor } = await aComposer({ value: line });

    expect(badgesIn(container)).toEqual(['src/a.ts:3-9']);
    expect(editor.state.doc.toString()).toBe(line);
  });

  it('gives a reference the icon and the colour of the kind of file it names', async () => {
    const { container } = await aComposer({ value: '@src/a.ts and @notes/plan.md' });
    const kinds = [...container.querySelectorAll('[data-testid="composer-reference"]')].map((badge) =>
      badge.getAttribute('data-file-kind'),
    );
    expect(kinds).toEqual(['code', 'text']);
    expect(container.querySelector('[data-testid="composer-reference"] svg')).not.toBeNull();
  });

  it('says nothing about an `@` inside a word, or one inside code', async () => {
    const { container } = await aComposer({ value: 'mail me@example.com about `@src/a.ts`' });
    expect(badgesIn(container)).toEqual([]);
  });

  it('takes the whole reference on Backspace, not one character of a path nobody can see', async () => {
    const line = 'Read @src/workbench/paths.ts:12-40 now';
    const { editor, onChange } = await aComposer({ value: line });

    // The cursor immediately after the badge, which is where a reader who has
    // just typed or picked a reference leaves it.
    act(() => editor.dispatch({ selection: { anchor: line.indexOf(' now') } }));
    fireEvent.keyDown(editor.contentDOM, { key: 'Backspace' });

    expect(editor.state.doc.toString()).toBe('Read  now');
    expect(onChange).toHaveBeenLastCalledWith('Read  now');
  });

  it('sends on Enter, breaks the line on Shift+Enter, and on a phone always breaks', async () => {
    const sent: string[] = [];
    /** The chat's own reading of a keystroke, as `chat-tab.tsx` spells it. */
    const answer = (phone: boolean) => (event: { key: string; shiftKey: boolean }) => {
      if (!enterSubmits(event, phone)) return false;
      sent.push('sent');
      return true;
    };

    const desk = await aComposer({ value: 'hello', onKey: answer(false) });
    fireEvent.keyDown(desk.editor.contentDOM, { key: 'Enter' });
    expect(sent).toEqual(['sent']);
    // Taken by the chat means taken from CodeMirror too: no newline was made.
    expect(desk.editor.state.doc.toString()).toBe('hello');

    fireEvent.keyDown(desk.editor.contentDOM, { key: 'Enter', shiftKey: true });
    expect(sent).toEqual(['sent']);
    expect(desk.editor.state.doc.toString()).toBe('hello\n');

    const phone = await aComposer({ value: 'hello', onKey: answer(true) });
    fireEvent.keyDown(phone.editor.contentDOM, { key: 'Enter' });
    expect(sent).toEqual(['sent']);
    expect(phone.editor.state.doc.toString()).toBe('hello\n');
  });

  it('is still a form control called `composer`, holding exactly the document', async () => {
    // Every end-to-end case in this repository types into that name and reads a
    // value back off it; the drawn line has neither.
    const { getByTestId, editor } = await aComposer({ value: 'Read @src/a.ts:4' });
    const box = getByTestId('composer') as HTMLTextAreaElement;
    expect(box.tagName).toBe('TEXTAREA');
    expect(box.value).toBe('Read @src/a.ts:4');
    expect(editor.state.doc.toString()).toBe(box.value);
  });
});
