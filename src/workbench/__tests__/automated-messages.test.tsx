/**
 * Every line Atelier sends into a chat on its own (a workflow stage's
 * prompt, a task's approval, a proposal's answer, a grid's) is drawn the
 * same way: one muted automated-message row with a mark for its kind and a
 * short label, the full text a click away. A message the owner typed stays
 * a message.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Mentions } from '@/components/markdown-body';
import type { LookableImage } from '@/workbench/protocol';
import { TranscriptRow } from '@/workbench/transcript-rows';
import type { TranscriptItem } from '@/workbench/use-session';

const MENTIONS: Mentions = { split: (text) => [{ kind: 'text', text }] };
const LOOK = (_image: LookableImage) => {};
const said = (text: string, from?: { kind: string; label: string }): TranscriptItem =>
  ({ kind: 'message', id: 'm-user', role: 'user', text, images: [], done: true, parentId: null, from }) as TranscriptItem;
const draw = (item: TranscriptItem) => render(<TranscriptRow item={item} sessionId="s" mentions={MENTIONS} onLook={LOOK} />);

describe('automated messages', () => {
  it('draws a workflow stage prompt as an automated message with its label', () => {
    draw(said('Work on KEY-1: Fix login\n\nWhen the stage is finished, report it.', { kind: 'workflow', label: 'Workflow stage: Implement' }));
    const row = screen.getByTestId('automated-message');
    expect(row.getAttribute('data-from')).toBe('workflow');
    expect(screen.getByTestId('automated-message-line').textContent).toContain('Workflow stage: Implement');
    expect(screen.queryByTestId('user-message')).toBeNull();
  });

  it('draws a task approval with the same row and a different mark', () => {
    const { unmount } = draw(said('Work on KEY-1', { kind: 'workflow', label: 'Workflow stage: Implement' }));
    const workflowMark = screen.getByTestId('automated-message').getAttribute('data-mark');
    unmount();
    draw(said('Owner approved task #3 "Plan ghosts".', { kind: 'task', label: 'You approved #3' }));
    const row = screen.getByTestId('automated-message');
    expect(row.getAttribute('data-from')).toBe('task');
    expect(screen.getByTestId('automated-message-line').textContent).toContain('You approved #3');
    expect(row.getAttribute('data-mark')).toBeTruthy();
    expect(row.getAttribute('data-mark')).not.toBe(workflowMark);
  });

  it('still draws answers recorded before messages carried where they came from', () => {
    const { unmount } = draw(said('Owner approved task #3 "Plan ghosts". It names no commits, so nothing is left to merge.'));
    expect(screen.getByTestId('automated-message-line').textContent).toContain('You approved #3');
    unmount();
    draw(said('The workflow approved task #10 "KEY-2315: keep the page".'));
    expect(screen.getByTestId('automated-message')).toBeTruthy();
    expect(screen.queryByTestId('user-message')).toBeNull();
  });

  it('shows the full text when unfolded, by keyboard too, and keeps a long label to one line', () => {
    const long = `Workflow stage: ${'Handle the QA rejection and fix it '.repeat(8)}`;
    draw(said('The whole stage prompt, with every instruction.', { kind: 'workflow', label: long }));
    const toggle = screen.getByTestId('automated-message-toggle');
    expect(toggle.getAttribute('aria-label')).toBe('Show full message');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('automated-message-line').querySelector('.truncate')).not.toBeNull();
    expect(screen.getByTestId('automated-message-line').tabIndex).toBe(0);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Hide full message');
    expect(screen.getByTestId('automated-message-full').textContent).toContain('The whole stage prompt, with every instruction.');
  });

  it('leaves a message the owner typed as a message', () => {
    draw(said('Owner approved this earlier, go on'));
    expect(screen.queryByTestId('automated-message')).toBeNull();
    expect(screen.getByTestId('user-message')).toBeTruthy();
  });
});
