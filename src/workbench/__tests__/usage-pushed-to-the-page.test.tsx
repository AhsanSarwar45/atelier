/**
 * The plan chips on a chat nobody is typing in.
 *
 * The complaint: the figures at the top of a chat only moved when THAT chat
 * moved, so a conversation left sitting while another one spent showed a number
 * from minutes ago (bw-dmoe).
 *
 * The figure is the account's, so no screen reads it: the sidecar keeps it
 * fresh and says it down the stream every page already holds. What is checked
 * here is that the chat draws what arrives without ever asking, and that two
 * screens open at once are looking at one number rather than two.
 */
import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlanUsage } from '@/workbench/plan-usage';

import { tagged } from './tagged';

/** Every stream opened during a case, newest last. */
let opened: FakeStream[] = [];

/** The browser's WebSocket, as much of it as the live store touches. */
class FakeStream {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    opened.push(this);
  }

  close(): void {
    this.closed = true;
  }


  /** The sidecar says what the account has spent. */
  saysUsage(percent: number): void {
    this.onmessage?.(tagged('workbench', JSON.stringify({ kind: 'usage', usage: reading(percent) })));
  }
}

function reading(percent: number): PlanUsage {
  return {
    available: true,
    plan: 'max',
    session: {
      key: 'session',
      label: 'This session',
      percent,
      resetsAt: '2026-08-20T22:20:00Z',
      severity: 'normal',
    },
    week: { key: 'week', label: 'This week', percent: 70, resetsAt: null, severity: 'normal' },
    perModel: [],
    credits: null,
    driving: [],
    at: '2026-08-20T18:00:00Z',
  };
}

async function freshModule() {
  vi.resetModules();
  return await import('@/workbench/live');
}

beforeEach(() => {
  opened = [];
  vi.stubGlobal('WebSocket', FakeStream);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('the screen asked for the plan figure itself'))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the plan figure on a silent chat', () => {
  it('arrives on the stream, and is never asked for', async () => {
    const { usePlanUsage } = await freshModule();
    const { result } = renderHook(() => usePlanUsage());

    expect(result.current.available, 'a figure was claimed before the sidecar said one').toBe(false);
    expect(globalThis.fetch, 'the screen went and asked for it').not.toHaveBeenCalled();

    act(() => opened[0].saysUsage(47));
    expect(result.current.session?.percent).toBe(47);

    // The account spends in another chat entirely; this one is not touched and
    // still moves.
    act(() => opened[0].saysUsage(52));
    expect(result.current.session?.percent).toBe(52);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('is one number for every screen on it, over one connection', async () => {
    const { usePlanUsage } = await freshModule();
    const first = renderHook(() => usePlanUsage());
    const second = renderHook(() => usePlanUsage());

    expect(opened.length, 'each screen opened its own stream').toBe(1);
    act(() => opened[0].saysUsage(61));
    expect(first.result.current.session?.percent).toBe(61);
    expect(second.result.current.session?.percent).toBe(61);
  });

  it('draws the figure the stream said on the chip itself', async () => {
    const { usePlanUsage } = await freshModule();
    const { PlanChip } = await import('@/workbench/usage-view');

    function Chip() {
      return <PlanChip usage={usePlanUsage()} onOpen={() => {}} />;
    }
    render(<Chip />);
    expect(screen.queryByTestId('plan-chip'), 'a chip was drawn before any figure arrived').toBeNull();

    act(() => opened[0].saysUsage(47));
    const chip = screen.getByTestId('plan-chip');
    expect(chip.textContent).toContain('5h 47%');
    expect(chip.getAttribute('data-percent')).toBe('47');
  });
});
