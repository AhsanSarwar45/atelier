import { useMemo } from 'react';

import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BeadChip } from '@/components/bead-chip-row';
import { MarkdownBody, type Mentions } from '@/components/markdown-body';
import { BACKSTOP_POLL_MS, useKnownCardStatuses, useKnownCards } from '@/workbench/known-cards';
import { addressedBy, mentionsIn } from '@/workbench/mentions';

const loadProjectBeads = vi.fn();
let boardChanged: (() => void) | undefined;

vi.mock('@/lib/beads-parser', () => ({
  loadProjectBeads: (...args: unknown[]) => loadProjectBeads(...args),
}));

vi.mock('@/lib/api', () => ({
  watch: {
    beads: (_path: string, changed: () => void) => {
      boardChanged = changed;
      return () => {};
    },
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const HERE = '7ec315b6-f66e-421e-84ae-a28088bdf16b';
const MENTIONS: Mentions = {
  split: (text) => mentionsIn(text, { card: (id) => id === 'bw-1u1' }),
  card: (id) => <BeadChip id={id} projectId={HERE} status="in_progress" size="sm" testId="mention-card" className="mx-0.5 align-middle" />,
  link: (href) => {
    const named = addressedBy(href);
    if (!named || named.kind !== 'card' || (named.project && named.project !== HERE)) return null;
    return named.id === 'bw-1u1' ? MENTIONS.card(named.id) : null;
  },
};

const say = (text: string) => render(<MarkdownBody mentions={MENTIONS}>{text}</MarkdownBody>);

function LiveMention({ project = '/project' }: { project?: string }) {
  const cards = useKnownCards(project);
  const statuses = useKnownCardStatuses(project);
  const mentions = useMemo<Mentions>(() => ({
    split: (text) => mentionsIn(text, { card: (id) => cards.has(id) }),
    card: (id) => <BeadChip id={id} projectId={HERE} status={statuses.get(id)} size="sm" testId="live-mention-card" />,
  }), [cards, statuses]);
  return <MarkdownBody mentions={mentions}>Working on bw-1u1</MarkdownBody>;
}

describe('card names in a rendered message', () => {
  it('draws this project card address as a chip', () => {
    say(`Landed: http://127.0.0.1:3008/project?id=${HERE}&card=bw-1u1`);
    expect(screen.getByTestId('mention-card')).toHaveTextContent('bw-1u1');
    expect(screen.queryByTestId('markdown-link')).toBeNull();
  });

  it('keeps the writer own words on a labelled link', () => {
    say(`[read it](http://127.0.0.1:3008/project?id=${HERE}&card=bw-1u1) when you can`);
    expect(screen.queryByTestId('mention-card')).toBeNull();
    expect(screen.getByTestId('markdown-link')).toHaveTextContent('read it');
  });

  it('does not turn another project card into this project chip', () => {
    say('http://127.0.0.1:3008/project?id=another-project&card=bw-1u1');
    expect(screen.queryByTestId('mention-card')).toBeNull();
    expect(screen.getByTestId('markdown-link')).toBeVisible();
  });

  it('centres a card chip on the surrounding words', () => {
    say('Landed bw-1u1 today');
    const chip = screen.getByTestId('mention-card');
    expect(chip).toHaveClass('align-middle');
    expect(chip).not.toHaveClass('align-baseline');
  });

  it('draws a card chip when a provider writes the id as inline code', () => {
    say('Landed `bw-1u1` today');
    const chip = screen.getByTestId('mention-card');
    expect(chip).toHaveTextContent('bw-1u1');
    expect(chip.closest('code')).toBeNull();
    expect(chip).toHaveClass('h-5');
  });

  it('does not consume a card id that is one directory inside a path', () => {
    say('See /home/me/worktrees/bw-1u1/src/app.ts');
    expect(screen.queryByTestId('mention-card')).toBeNull();
    expect(screen.getByText(/\/home\/me\/worktrees\/bw-1u1\/src\/app\.ts/)).toBeVisible();
  });

  it('does not consume a card id embedded in a larger token', () => {
    say('The cache key is prefix_bw-1u1_suffix');
    expect(screen.queryByTestId('mention-card')).toBeNull();
    expect(screen.getByText(/prefix_bw-1u1_suffix/)).toBeVisible();
  });

  it('uses the existing board status color on a card chip', () => {
    say('Working on bw-1u1');
    expect(screen.getByTestId('mention-card')).toHaveAttribute('data-bead-status', 'in_progress');
    expect(screen.getByTestId('mention-card')).toHaveClass('text-status-progress');
  });

  it('updates an already drawn chip from one shared board change', async () => {
    loadProjectBeads
      .mockResolvedValueOnce({ beads: [{ id: 'bw-1u1', status: 'open', updated_at: '2026-09-07T00:00:00Z' }], source: 'cli' })
      .mockResolvedValueOnce({ beads: [{ id: 'bw-1u1', status: 'closed', updated_at: '2026-09-07T00:00:01Z' }], source: 'cli' });

    render(<LiveMention />);
    await waitFor(() => expect(screen.getByTestId('live-mention-card')).toHaveAttribute('data-bead-status', 'open'));

    act(() => boardChanged?.());
    await waitFor(() => expect(screen.getByTestId('live-mention-card')).toHaveAttribute('data-bead-status', 'closed'));
    expect(screen.getByTestId('live-mention-card')).toHaveClass('text-status-closed');
    expect(loadProjectBeads).toHaveBeenCalledTimes(2);
    // The second read asks only for what moved since the first, as the board page does.
    expect(loadProjectBeads).toHaveBeenLastCalledWith('/project', { withSource: true, updatedAfter: '2026-09-07T00:00:00Z' });
  });

  it('asks a Dolt board again every backstop period, whether or not a change frame came', async () => {
    vi.useFakeTimers();
    loadProjectBeads.mockClear();
    try {
      loadProjectBeads
        .mockResolvedValueOnce({ beads: [{ id: 'bw-1u1', status: 'open', updated_at: '2026-09-07T00:00:00Z' }], source: 'dolt-project' })
        .mockResolvedValueOnce({ beads: [{ id: 'bw-1u1', status: 'closed', updated_at: '2026-09-07T00:00:01Z' }], source: 'dolt-project' });

      render(<LiveMention project="dolt://board" />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByTestId('live-mention-card')).toHaveAttribute('data-bead-status', 'open');

      await act(async () => { await vi.advanceTimersByTimeAsync(BACKSTOP_POLL_MS); });
      expect(screen.getByTestId('live-mention-card')).toHaveAttribute('data-bead-status', 'closed');
      expect(loadProjectBeads).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('draws a card the board has not answered for in the muted set, never the open blue', () => {
    render(<BeadChip id="wl-none" projectId={HERE} size="sm" testId="unknown-card" />);
    const chip = screen.getByTestId('unknown-card');
    expect(chip).not.toHaveAttribute('data-bead-status');
    expect(chip).toHaveClass('text-t-tertiary');
    expect(chip).not.toHaveClass('text-status-open');
  });

  it('keeps card ids inside fenced commands copyable as code', () => {
    say('```sh\nbd show bw-1u1\n```');
    expect(screen.queryByTestId('mention-card')).toBeNull();
    expect(screen.getByText(/bd show bw-1u1/)).toBeVisible();
  });
});
