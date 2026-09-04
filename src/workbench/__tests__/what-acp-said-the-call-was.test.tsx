/**
 * What ACP itself says about a call, which the row used to ignore entirely.
 *
 * ACP states a call's KIND -- `read`, `edit`, `execute` -- and the places it
 * touched. Every rule here guessed the kind from the tool's NAME instead, which
 * works only for names the table has heard of: an agent whose shell tool is not
 * called `Bash` drew its command as a `key: value` form beside a colourless,
 * markless row, next to a chat that knew perfectly well what the call was. The
 * places were read by nobody at all (bw-t26l.20).
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { EMPTY, foldAll, reduce, type TranscriptTool } from '@/workbench/fold';
import { ranOfAcp } from '@/workbench/said-what-it-ran';
import { ToolRow } from '@/workbench/transcript-rows';
import type { WbpEvent } from '@/workbench/protocol';

let stamped = 0;
type Said<T> = T extends unknown ? Omit<T, 'seq' | 'sessionId' | 'at'> : never;
function said(e: Said<WbpEvent>): WbpEvent {
  stamped += 1;
  return { ...e, seq: stamped, sessionId: 'chat-1', at: '2026-08-20T00:00:00.000Z' } as WbpEvent;
}

/** An agent whose shell tool is not called `Bash` and whose reader is not `Read`. */
const foreign = (): WbpEvent[] => [
  said({
    type: 'tool.started',
    toolCallId: 'call-1',
    name: 'shell.run',
    input: { command: 'cargo test --lib' },
    title: 'shell.run cargo test --lib',
    parentToolCallId: null,
    acpKind: 'execute',
  }),
  said({
    type: 'tool.started',
    toolCallId: 'call-1',
    name: 'shell.run',
    input: { command: 'cargo test --lib' },
    title: 'shell.run cargo test --lib',
    parentToolCallId: null,
    acpKind: 'execute',
    locations: [{ path: '/work/server/src/lib.rs', line: 42 }],
  }),
];

describe('what ACP said the call was', () => {
  it('translates every kind that has an honest translation', () => {
    expect(ranOfAcp('execute')).toBe('run');
    expect(ranOfAcp('delete')).toBe('grave');
    expect(ranOfAcp('fetch')).toBe('web');
    // `other` is the protocol's own word for "no idea", and there is no kind
    // here for an agent's private reasoning. Both leave the row as it was.
    expect(ranOfAcp('other')).toBeNull();
    expect(ranOfAcp('think')).toBeNull();
    expect(ranOfAcp(null)).toBeNull();
  });

  it('reaches the row on both folds, and a later ping does not empty it', () => {
    const live = foreign().reduce((view, event) => reduce(view, event), EMPTY);
    const replayed = foldAll(foreign());
    for (const view of [live, replayed]) {
      const call = view.items.find((it): it is TranscriptTool => it.kind === 'tool');
      expect(call?.acpKind).toBe('execute');
      expect(call?.locations).toEqual([{ path: '/work/server/src/lib.rs', line: 42 }]);
    }
  });

  it('colours the row and prints the command as a command', () => {
    const call = foldAll(foreign()).items.find((it): it is TranscriptTool => it.kind === 'tool')!;
    const drawn = render(<ToolRow item={call} nested={false} />);
    // Not colourless: ACP said it ran something.
    expect(drawn.container.querySelector('[data-testid="tool-row"]')).toHaveAttribute('data-ran-kind', 'run');
    // And where it touched, said once, clickable.
    expect(screen.getByTestId('tool-locations')).toBeInTheDocument();
    expect(screen.getByText('src/lib.rs')).toBeInTheDocument();
  });
});
