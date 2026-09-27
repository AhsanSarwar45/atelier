import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PlanUsage } from '@/workbench/plan-usage';

const usage: PlanUsage = {
  available: true,
  plan: 'max',
  session: null,
  week: null,
  perModel: [],
  credits: null,
  driving: [{
    span: 'day',
    requests: 3064,
    sessions: 17,
    traits: [
      { key: 'high_parallel', label: 'Parallel agent tasks', pct: 49 },
      { key: 'subagent_heavy', label: 'Requests using subagents', pct: 45 },
    ],
    agents: [{ name: 'general-purpose', pct: 5 }],
    skills: [],
    plugins: [],
    servers: [{ name: 'chrome-devtools', pct: 7 }],
  }],
  resets: null,
  at: '2026-09-20T00:00:00Z',
};

const request = vi.fn(async () => ({ ok: true, json: async () => usage }));
vi.mock('@/lib/api', () => ({ request: (...args: unknown[]) => request(...args) }));

vi.mock('@/workbench/live', () => ({
  useChatNames: () => new Map(),
  usePlanUsage: () => usage,
}));

import { UsageView, readableName } from '@/workbench/usage-view';

describe('usage explanations', () => {
  it('turns internal identifiers into readable names', () => {
    expect(readableName('general-purpose')).toBe('General Purpose');
    expect(readableName('chrome-devtools')).toBe('Chrome DevTools');
  });

  // The breakdown costs Claude a read of every transcript of the last week,
  // so the chip's beats skip it and only the open view asks (bw-xeeqg.17).
  it('asks for what is driving the usage only when the view opens', async () => {
    expect(request).not.toHaveBeenCalled();
    render(<UsageView profile="work" onClose={() => {}} />);
    await waitFor(() => expect(request).toHaveBeenCalledWith('/api/workbench/usage?brand=claude&breakdown=true&profile=work'));
    request.mockClear();
    render(<UsageView brand="codex" onClose={() => {}} />);
    expect(request).not.toHaveBeenCalled();
  });

  it('states what every percentage measures', () => {
    render(<UsageView onClose={() => {}} />);

    expect(screen.getByText('Request patterns')).toBeInTheDocument();
    expect(screen.getByText('Percentages can overlap')).toBeInTheDocument();
    expect(screen.getByLabelText(/Parallel agent tasks: 49% of requests/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Requests using subagents: 45% of requests/)).toBeInTheDocument();
    expect(screen.getByText('Agent types')).toBeInTheDocument();
    expect(screen.getByText('Tool servers')).toBeInTheDocument();
    expect(screen.getByText('Tools used')).toBeInTheDocument();
    expect(screen.getByText('Share of requests')).toBeInTheDocument();
    expect(screen.getByText('General Purpose')).toBeInTheDocument();
    expect(screen.getByText('Chrome DevTools')).toBeInTheDocument();
  });

  it('explains a request pattern on hover', async () => {
    render(<UsageView onClose={() => {}} />);

    fireEvent.pointerMove(screen.getByLabelText(/Parallel agent tasks: 49% of requests/), {
      pointerType: 'mouse',
    });

    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toHaveTextContent(
        'Requests from sessions that ran several agent tasks at the same time.',
      );
      expect(screen.getByRole('tooltip')).toHaveTextContent('Percentages can overlap.');
    }, { timeout: 2000 });
  });
});
