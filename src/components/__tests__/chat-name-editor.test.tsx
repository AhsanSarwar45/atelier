import { useState } from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatNamePart } from '@/lib/api';

import { ChatNameEditor, ticketKeyPattern, ticketKeyTemplate } from '../settings/chat-name-editor';

const mocks = vi.hoisted(() => ({ chatNamePreview: vi.fn() }));
vi.mock('@/lib/api', () => ({ projects: { chatNamePreview: mocks.chatNamePreview } }));

function Harness({ start = [] as ChatNamePart[], seen }: { start?: ChatNamePart[]; seen: (parts: ChatNamePart[]) => void }) {
  const [parts, setParts] = useState(start);
  return (
    <ChatNameEditor
      projectId="p1"
      prefix="bw"
      parts={parts}
      onChange={(next) => {
        setParts(next);
        seen(next);
      }}
    />
  );
}

describe('chat name editor', () => {
  beforeEach(() => {
    mocks.chatNamePreview.mockReset();
    mocks.chatNamePreview.mockResolvedValue({
      problems: [],
      chats: [{ sessionId: 's1', now: 'Fix the tray', then: 'bw-a9ln: Fix the tray', namedByOwner: false }],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('offers the ticket key of the worktree as one click', async () => {
    const seen = vi.fn();
    render(<Harness seen={seen} />);
    fireEvent.click(screen.getByTestId('chat-name-preset'));

    expect(seen).toHaveBeenLastCalledWith(ticketKeyTemplate('bw'));
    expect(screen.getAllByTestId('chat-name-chip').map((chip) => chip.dataset.kind)).toEqual(['extract', 'text', 'title']);
    expect(await screen.findByText('bw-a9ln: Fix the tray')).toBeVisible();
    expect(mocks.chatNamePreview).toHaveBeenLastCalledWith('p1', { parts: ticketKeyTemplate('bw') });
  });

  it('builds the key pattern from the card prefix, escaped', () => {
    expect(ticketKeyPattern('bw')).toBe('bw-[a-z0-9]+');
    expect(ticketKeyPattern('a.b')).toBe('a\\.b-[a-z0-9]+');
    expect(ticketKeyPattern('')).toBe('[A-Za-z]+-[0-9]+');
  });

  it('edits a pattern in place and shows what is wrong with it', async () => {
    mocks.chatNamePreview.mockImplementation(async (_id: string, { parts }: { parts: ChatNamePart[] }) => ({
      problems: parts.some((part) => part.kind === 'extract' && part.pattern.endsWith('('))
        ? [{ index: 0, message: 'Not a valid pattern: unclosed group' }]
        : [],
      chats: [],
    }));
    const seen = vi.fn();
    render(<Harness seen={seen} start={ticketKeyTemplate('bw')} />);

    fireEvent.click(screen.getAllByTestId('chat-name-chip-edit')[0]);
    fireEvent.change(await screen.findByTestId('chat-name-pattern'), { target: { value: 'bw-(' } });

    expect(seen).toHaveBeenLastCalledWith([
      { kind: 'extract', source: 'worktree', pattern: 'bw-(' },
      { kind: 'text', text: ': ' },
      { kind: 'title' },
    ]);
    expect(await screen.findByTestId('chat-name-problem')).toHaveTextContent('unclosed group');
  });

  it('removes a part and clears the whole template', () => {
    const seen = vi.fn();
    render(<Harness seen={seen} start={ticketKeyTemplate('bw')} />);

    fireEvent.click(screen.getAllByTestId('chat-name-remove')[1]);
    expect(seen).toHaveBeenLastCalledWith([ticketKeyTemplate('bw')[0], { kind: 'title' }]);

    fireEvent.click(screen.getByTestId('chat-name-clear'));
    expect(seen).toHaveBeenLastCalledWith([]);
    expect(screen.getByTestId('chat-name-preset')).toBeVisible();
  });

  it('reorders parts from the keyboard', async () => {
    const seen = vi.fn();
    render(<Harness seen={seen} start={ticketKeyTemplate('bw')} />);
    const handle = screen.getAllByRole('button', { name: 'Drag to reorder' })[2];

    handle.focus();
    await act(async () => {
      fireEvent.keyDown(handle, { code: 'Space', key: ' ' });
    });
    await act(async () => {
      fireEvent.keyDown(handle, { code: 'ArrowLeft', key: 'ArrowLeft' });
    });
    await act(async () => {
      fireEvent.keyDown(handle, { code: 'ArrowLeft', key: 'ArrowLeft' });
    });
    await act(async () => {
      fireEvent.keyDown(handle, { code: 'Space', key: ' ' });
    });

    await waitFor(() => expect(seen).toHaveBeenCalled());
    expect(seen.mock.lastCall?.[0][0]).toEqual({ kind: 'title' });
  });
});
