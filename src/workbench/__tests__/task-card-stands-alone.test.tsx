/** A task card printed by `atelier task` is its own card, not a card inside a reply. */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Mentions } from '@/components/markdown-body';
import { widgetBlock } from '@/workbench/chat-widgets';
import { makeTask } from '@/workbench/tasks/__tests__/fixtures';
import type { TaskWidget } from '@/workbench/tasks/types';
import { TranscriptRow } from '@/workbench/transcript-rows';
import type { TranscriptItem } from '@/workbench/use-session';

vi.mock('@/workbench/live', async (original) => ({
  ...(await original<typeof import('@/workbench/live')>()),
  useLiveSessions: () => [],
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/project',
}));

const MENTIONS: Mentions = { split: (text) => [{ kind: 'text', text }] };
const task: TaskWidget = { type: 'task', event: 'start', task: makeTask({ status: 'in_progress' }) };

const row = (over: Partial<Extract<TranscriptItem, { kind: 'message' }>>): TranscriptItem =>
  ({ kind: 'message', id: 'm', role: 'assistant', text: widgetBlock(task)!, images: [], widgets: [task], done: true, parentId: null, ...over }) as TranscriptItem;

const draw = (item: TranscriptItem) => render(<TranscriptRow item={item} sessionId="s" mentions={MENTIONS} onLook={() => {}} />);

describe('a task card in a chat', () => {
  it('has no message box around it', () => {
    draw(row({ presentedBy: 'tool-1' }));
    const box = screen.getByTestId('assistant-message').className;
    expect(box).not.toContain('bg-muted/40');
    expect(box).not.toContain('border-r-2');
    expect(box).not.toContain('px-3');
    expect(screen.getByTestId('task-card')).toBeInTheDocument();
  });

  it('keeps the box when the agent wrote it into a reply', () => {
    draw(row({}));
    expect(screen.getByTestId('assistant-message').className).toContain('bg-muted/40');
  });
});
