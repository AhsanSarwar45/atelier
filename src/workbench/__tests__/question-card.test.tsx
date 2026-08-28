import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendCommand } = vi.hoisted(() => ({ sendCommand: vi.fn().mockResolvedValue({}) }));
vi.mock('@/workbench/use-session', async (load) => {
  const actual = await load<typeof import('@/workbench/use-session')>();
  return { ...actual, sendCommand };
});

import { QuestionCard } from '@/workbench/transcript-rows';
import type { TranscriptItem } from '@/workbench/use-session';

const request = (overrides: Partial<Extract<TranscriptItem, { kind: 'question' }>> = {}): Extract<TranscriptItem, { kind: 'question' }> => ({
  kind: 'question', id: 'request-1', blocking: true, answers: null, parentId: null, askedBy: null,
  questions: [
    {
      id: 'database', header: 'Database', prompt: 'Which database should we use?', selection: 'single',
      options: [
        { id: 'pg', label: 'Postgres', description: 'Durable relational storage.' },
        { id: 'sqlite', label: 'SQLite', description: 'A local embedded database.' },
      ],
      allowCustom: true, secret: false,
    },
    {
      id: 'checks', header: 'Checks', prompt: 'Which checks should run?', selection: 'multiple',
      options: [{ id: 'unit', label: 'Unit tests' }, { id: 'e2e', label: 'Browser tests' }],
      allowCustom: true, secret: false,
    },
  ],
  ...overrides,
});

describe('question card', () => {
  beforeEach(() => sendCommand.mockClear());

  it('groups vertical described choices and sends one deliberate multi-answer response with a note', async () => {
    render(<QuestionCard item={request()} sessionId="session-1" />);
    expect(screen.getByText('Durable relational storage.')).toBeInTheDocument();
    const answer = screen.getByRole('button', { name: 'Answer' });
    expect(answer).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Postgres' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'SQLite' }));
    expect(screen.getByRole('checkbox', { name: 'Postgres' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Unit tests' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Browser tests' }));

    const checks = screen.getByRole('group', { name: 'Checks' });
    fireEvent.click(within(checks).getByRole('button', { name: 'Add note' }));
    fireEvent.change(within(checks).getByLabelText('Note for Checks'), { target: { value: 'Run on CI' } });
    expect(answer).toBeEnabled();
    fireEvent.click(answer);

    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith({
      type: 'question.answer', sessionId: 'session-1', requestId: 'request-1', response: { answers: [
        { questionId: 'database', optionIds: ['sqlite'] },
        { questionId: 'checks', optionIds: ['unit', 'e2e'], note: 'Run on CI' },
      ] },
    }));
  });

  it('lets typing activate the custom row and keeps secret resolved text masked', async () => {
    const item = request({ questions: [{
      id: 'token', header: 'Token', prompt: 'Supply it', selection: 'text', options: [], allowCustom: true, secret: true,
    }] });
    const { rerender } = render(<QuestionCard item={item} sessionId="session-1" />);
    const input = screen.getByLabelText('Answer');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.change(input, { target: { value: 'sensitive' } });
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    await waitFor(() => expect(sendCommand).toHaveBeenCalled());

    rerender(<QuestionCard item={{ ...item, answers: [{ questionId: 'token', optionIds: [], customText: 'sensitive' }] }} sessionId="session-1" />);
    expect(screen.queryByText('sensitive')).not.toBeInTheDocument();
    expect(screen.getByText(/••••/)).toBeInTheDocument();
  });
});
