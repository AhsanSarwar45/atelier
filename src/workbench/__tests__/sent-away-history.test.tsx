import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { request } from '@/lib/api';
import type { SentAway } from '@/workbench/fold';
import { SentAwayPanel, type SentAwayPanelProps } from '@/workbench/sent-away';

vi.mock('@/lib/api', () => ({ request: vi.fn() }));

const row = (id: string, extra: Partial<SentAway> = {}): SentAway => ({
  id, toolCallId: `call-${id}`, kind: 'helper', what: `Task ${id}`, agentType: 'reviewer',
  model: null, state: 'done', startedAt: 1, seconds: 12, tokens: 100, calls: 2,
  doing: null, result: `Result ${id}`, relayed: [], ...extra,
});
const page = (agents: SentAway[], cursor: number | null = null, hasMore = false) =>
  new Response(JSON.stringify({ agents, cursor, hasMore }), { status: 200 });
const props = (extra: Partial<SentAwayPanelProps> = {}): SentAwayPanelProps => ({
  agents: [], finishedAgentCount: 696, items: [], sessionId: 'chat one', controls: [], ...extra,
});
const expand = () => fireEvent.click(screen.getByTestId('toggle-stopped-agents'));
const ids = () => screen.queryAllByTestId('sent-away-row').map(el => el.getAttribute('data-agent'));

beforeEach(() => vi.mocked(request).mockReset());

describe('completed agent history', () => {
  it('mounts no completed rows and makes no history request until expanded', async () => {
    vi.mocked(request).mockResolvedValue(page([row('old')]));
    render(<SentAwayPanel {...props()} />);
    expect(screen.getByTestId('toggle-stopped-agents')).toHaveTextContent('Show 696 completed');
    expect(ids()).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    expand();
    await screen.findByText('Task old');
    expect(request).toHaveBeenCalledWith('/api/workbench/agents?session=chat%20one');
    expand();
    expect(ids()).toEqual([]);
    expand();
    expect(ids()).toEqual(['old']);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('fetches the next bounded page only when Load more is clicked', async () => {
    const first = Array.from({ length: 3 }, (_, i) => row(`old-${i}`));
    vi.mocked(request).mockResolvedValueOnce(page(first, 40, true)).mockResolvedValueOnce(page([row('last')], 41));
    render(<SentAwayPanel {...props({ finishedAgentCount: 41 })} />);
    expand();
    await screen.findByText('Task old-2');
    expect(ids()).toHaveLength(3);
    expect(request).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('Task last');
    expect(ids()).toHaveLength(4);
    expect(request).toHaveBeenLastCalledWith('/api/workbench/agents?session=chat%20one&after=40');
    expect(screen.queryByTestId('load-more-agents')).toBeNull();
  });

  it('retries a failed page without losing already loaded rows or advancing the cursor', async () => {
    vi.mocked(request).mockResolvedValueOnce(page([row('first')], 40, true))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(page([row('second')], 41));
    render(<SentAwayPanel {...props()} />);
    expand();
    await screen.findByText('Task first');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByRole('alert');
    expect(ids()).toEqual(['first']);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Task second');
    expect(ids()).toEqual(['first', 'second']);
    expect(vi.mocked(request).mock.calls.slice(1).map(args => args[0])).toEqual([
      '/api/workbench/agents?session=chat%20one&after=40', '/api/workbench/agents?session=chat%20one&after=40',
    ]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('uses the live row when a historical page contains the same agent, and opens the full live row', async () => {
    const latest = row('same', { result: 'Newest completion', seconds: 99, relayed: ['Follow up'] });
    vi.mocked(request).mockResolvedValue(page([row('same', { result: 'Stale completion' }), row('other')]));
    const onOpen = vi.fn();
    render(<SentAwayPanel {...props({ agents: [latest], onOpen })} />);
    expand();
    await screen.findByText('Task other');
    expect(ids()).toEqual(['same', 'other']);
    expect(screen.queryByText('Stale completion')).toBeNull();
    fireEvent.click(screen.getByText('Newest completion'));
    expect(onOpen).toHaveBeenCalledWith('same', latest);
  });

  it('adds new live completions to the omitted historical count', () => {
    const active = row('live', { state: 'running' });
    const initial = props({ agents: [active] });
    const view = render(<SentAwayPanel {...initial} />);
    expect(screen.getByTestId('toggle-stopped-agents')).toHaveTextContent('Show 696 completed');
    view.rerender(<SentAwayPanel {...initial} agents={[{ ...active, state: 'done' }]} />);
    expect(screen.getByTestId('toggle-stopped-agents')).toHaveTextContent('Show 697 completed');
    expect(screen.getByTestId('sent-away-panel')).toHaveAttribute('data-running', '0');
    expect(ids()).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it('reloads completed history when a recovery snapshot moves live completions into history', async () => {
    vi.mocked(request).mockResolvedValueOnce(page([row('old')]))
      .mockResolvedValueOnce(page([row('old'), row('new')]));
    const initial = props({ finishedAgentCount: 1, agents: [row('new')] });
    const view = render(<SentAwayPanel {...initial} />);
    expand();
    await screen.findByText('Task old');
    expect(ids()).toEqual(['old', 'new']);
    view.rerender(<SentAwayPanel {...initial} finishedAgentCount={2} agents={[]} />);
    await waitFor(() => expect(ids()).toEqual(['old', 'new']));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith('/api/workbench/agents?session=chat%20one');
    expect(screen.queryByTestId('load-more-agents')).toBeNull();
  });

  it('ignores a pending page from the previous session and starts the next chat collapsed', async () => {
    let resolveOld!: (response: Response) => void;
    vi.mocked(request).mockReturnValueOnce(new Promise<Response>(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce(page([row('new-chat')]));
    const view = render(<SentAwayPanel {...props()} />);
    expand();
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    view.rerender(<SentAwayPanel {...props({ sessionId: 'new-chat' })} />);
    expect(screen.getByTestId('toggle-stopped-agents')).toHaveAttribute('aria-expanded', 'false');
    await act(async () => { resolveOld(page([row('old-chat')])); });
    expect(ids()).toEqual([]);
    expand();
    await screen.findByText('Task new-chat');
    expect(ids()).toEqual(['new-chat']);
    await waitFor(() => expect(request).toHaveBeenLastCalledWith('/api/workbench/agents?session=new-chat'));
  });
});
