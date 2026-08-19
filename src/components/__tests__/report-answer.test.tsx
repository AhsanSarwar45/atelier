/**
 * Sending an answer instead of copying it (bw-7ks.21.5).
 *
 * The end-to-end run proves the answer really lands on a board and in a chat;
 * this proves the two things that run can't see cheaply — that the words sent
 * carry the question, and that nothing is sent until the manager has seen where
 * it is going.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReportDocument } from '@/components/report/report-document';
import { chatText, commentText, saidWhere, type Answered } from '@/components/report/send-answer';

import { REPORT_FIXTURE } from './report-fixture';

const QUESTION = REPORT_FIXTURE.actions.questions[0];

const ANSWERED: Answered = {
  question: QUESTION,
  say: 'Ship the onboarding flow this week.',
  card: 'card-42',
};

interface Call {
  url: string;
  body: Record<string, unknown>;
}

/** Every request the page made, with the sidecar answering one chat. */
function stubFetch(calls: Call[], chats: unknown[] = [{ sessionId: 'sess-1', title: 'The chat that worked it' }]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, body });
    const answer = url.includes('/links/bead/') ? chats : { stdout: '', stderr: '', code: 0 };
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => answer,
      text: async () => JSON.stringify(answer),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

describe('the words that get sent', () => {
  it('a comment quotes the question above the answer and names the report', () => {
    const text = commentText('Demo report', ANSWERED);
    expect(text).toContain('Demo report');
    expect(text).toContain(`> ${QUESTION.ask}`);
    expect(text.indexOf(QUESTION.ask)).toBeLessThan(text.indexOf(ANSWERED.say));
  });

  it('a chat message carries every answer, each under its own question and card', () => {
    const text = chatText('Demo report', [ANSWERED]);
    expect(text).toContain(`> ${QUESTION.ask}`);
    expect(text).toContain(ANSWERED.say);
    expect(text).toContain('(card-42)');
  });

  it('the line afterwards says what took it and what did not', () => {
    expect(saidWhere({ comments: [{ card: 'card-42', ok: true }], chats: [] })).toBe('Written on the card.');
    expect(
      saidWhere({
        comments: [{ card: 'card-42', ok: true }],
        chats: [{ sessionId: 'sess-1', title: 'Chat', ok: false, error: 'held elsewhere' }],
      }),
    ).toContain('held elsewhere');
  });
});

describe('sending an answer from the report', () => {
  it('offers no send where the report has no project behind it', () => {
    render(<ReportDocument spec={REPORT_FIXTURE} />);
    expect(screen.queryByTestId('report-answer-send')).toBeNull();
    expect(screen.getByText('Copy my reply')).toBeInTheDocument();
  });

  it('names the card and the chat first, and sends nothing until that is confirmed', async () => {
    const calls: Call[] = [];
    stubFetch(calls);
    render(<ReportDocument spec={REPORT_FIXTURE} delivery={{ projectPath: '/tmp/project' }} />);

    fireEvent.click(screen.getByTestId('report-answer-send'));

    const target = await screen.findByTestId('report-answer-target-card');
    expect(target).toHaveAttribute('data-card-id', 'card-42');
    await waitFor(() => expect(screen.getByTestId('report-answer-target-chat')).toBeInTheDocument());
    expect(screen.getByTestId('report-answer-target-chat')).toHaveTextContent('The chat that worked it');

    // Only the chats have been read; nothing has been written anywhere.
    expect(calls.every((c) => c.url.includes('/links/bead/'))).toBe(true);

    fireEvent.click(screen.getByTestId('report-answer-confirm-send'));

    await waitFor(() => expect(screen.getByTestId('report-answer-result')).toBeInTheDocument());

    const comment = calls.find((c) => c.url.includes('/api/bd/command'));
    expect(comment).toBeDefined();
    expect(comment?.body.args).toEqual(['comment', 'card-42', expect.stringContaining(QUESTION.ask)]);
    expect(comment?.body.cwd).toBe('/tmp/project');

    const toChat = calls.find((c) => c.url.includes('/api/workbench/command'));
    expect(toChat?.body).toMatchObject({ type: 'prompt.send', sessionId: 'sess-1' });
    expect(String(toChat?.body.text)).toContain(QUESTION.ask);

    expect(screen.getByTestId('report-answer-result')).toHaveTextContent('Written on the card');
  });

  it('backing out sends nothing at all', async () => {
    const calls: Call[] = [];
    stubFetch(calls);
    render(<ReportDocument spec={REPORT_FIXTURE} delivery={{ projectPath: '/tmp/project' }} />);

    fireEvent.click(screen.getByTestId('report-answer-send'));
    await screen.findByTestId('report-answer-target-card');
    fireEvent.click(screen.getByTestId('report-answer-cancel'));

    expect(screen.queryByTestId('report-answer-confirm')).toBeNull();
    expect(calls.some((c) => c.url.includes('/api/bd/command'))).toBe(false);
  });
});
