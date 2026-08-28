import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendCommand } = vi.hoisted(() => ({ sendCommand: vi.fn().mockResolvedValue({}) }));
vi.mock('@/workbench/use-session', async (load) => {
  const actual = await load<typeof import('@/workbench/use-session')>();
  return { ...actual, sendCommand };
});

import { PlanProposalCard } from '@/workbench/transcript-rows';
import type { TranscriptItem } from '@/workbench/use-session';

const plan = (overrides: Partial<Extract<TranscriptItem, { kind: 'plan' }>> = {}): Extract<TranscriptItem, { kind: 'plan' }> => ({
  kind: 'plan', id: 'plan-1', markdown: '# Safer rollout\n\n1. Test it',
  actions: [
    { id: 'approve', kind: 'approve', label: 'Approve plan', description: 'Continue with this approach.' },
    { id: 'request_changes', kind: 'request_changes', label: 'Request changes', acceptsFeedback: true },
  ],
  status: 'proposed', actionId: null, feedback: null, parentId: null, askedBy: null,
  ...overrides,
});

describe('proposed plan card', () => {
  beforeEach(() => sendCommand.mockClear());

  it('renders Markdown and submits a provider-neutral action only after confirmation', async () => {
    render(<PlanProposalCard item={plan()} sessionId="session-1" />);
    expect(screen.getByRole('heading', { name: 'Safer rollout' })).toBeInTheDocument();
    expect(screen.getByText('Continue with this approach.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /^Approve plan/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith({
      type: 'plan.respond', sessionId: 'session-1', proposalId: 'plan-1', response: { actionId: 'approve' },
    }));
  });

  it('requires and sends feedback for a change request', async () => {
    render(<PlanProposalCard item={plan()} sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Requested plan changes'), { target: { value: 'Add rollback steps' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      response: { actionId: 'request_changes', feedback: 'Add rollback steps' },
    })));
  });
});
