/**
 * A row drawn for an agent that names its tools in prose.
 *
 * Claude stamps its tool's own name on every call, so the sentence rules had a
 * name to dispatch on and a Claude row said "Read part of provider.rs". Codex
 * sends a human title instead -- "Editing files", or the whole command -- and
 * the same work drew a `key: value` dump under the word "asked", with no verb
 * and no mark. The naming is done once, at the ACP seam (`normalize.rs`,
 * `call_named_by_acp`); these are the shapes it now hands the row, taken from
 * the events a real Codex chat wrote (bw-rg6p).
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { foldAll, type TranscriptTool } from '@/workbench/fold';
import { ToolRow } from '@/workbench/transcript-rows';
import type { WbpEvent } from '@/workbench/protocol';

let stamped = 0;
type Said<T> = T extends unknown ? Omit<T, 'seq' | 'sessionId' | 'at'> : never;
function said(e: Said<WbpEvent>): WbpEvent {
  stamped += 1;
  return { ...e, seq: stamped, sessionId: 'chat-1', at: '2026-08-20T00:00:00.000Z' } as WbpEvent;
}

/** The call, and the call finishing: the sentences are written for a row that
 *  is read after the fact, so a running row says "Searching" and a finished one
 *  says "Searched". */
function rowFor(event: WbpEvent, output = '') {
  const done = said({ type: 'tool.completed', toolCallId: (event as { toolCallId: string }).toolCallId, ok: true, output });
  return foldAll([event, done]).items.find((it): it is TranscriptTool => it.kind === 'tool')!;
}

describe('a Codex call reads as what it did', () => {
  it('says what a shell call ran, and prints it as a command rather than a form', () => {
    // What Codex sends: no tool name of its own, the command as the title, and
    // the command again in `rawInput`. The seam names it `Bash`.
    const row = rowFor(
      said({
        type: 'tool.started',
        toolCallId: 'exec-1',
        name: 'Bash',
        input: { command: 'rg -n needle src', cwd: '/work' },
        title: 'rg -n needle src',
        parentToolCallId: null,
        acpKind: 'execute',
      }),
    );
    render(<ToolRow item={row} nested={false} />);
    const drawn = screen.getByTestId('tool-row');
    expect(drawn).toHaveAttribute('data-ran-kind', 'search');
    expect(screen.getByTestId('tool-mark')).toBeInTheDocument();
    expect(drawn.textContent).toContain('Searched for needle in src');

    // And behind the click the command is a command, not `command: rg -n …`.
    fireEvent.click(screen.getAllByRole('button')[0]);
    const body = screen.getByTestId('tool-input');
    expect(body.textContent).toContain('rg -n needle src');
    expect(body.textContent).not.toContain('cwd:');
  });

  it('names the file a read or an edit touched', () => {
    const read = rowFor(
      said({
        type: 'tool.started',
        toolCallId: 'read-1',
        name: 'Read',
        // `path` is what Codex sent; `file_path` is the seam copying it to the
        // key the rules read a file by.
        input: { path: '/work/src/lib.rs', file_path: '/work/src/lib.rs' },
        title: "Read file '/work/src/lib.rs'",
        parentToolCallId: null,
        acpKind: 'read',
        locations: [{ path: '/work/src/lib.rs', line: null }],
      }),
    );
    render(<ToolRow item={read} nested={false} />);
    expect(screen.getByTestId('tool-row')).toHaveAttribute('data-ran-kind', 'read');
    expect(screen.getByTestId('tool-row').textContent).toContain('Read src/lib.rs');
  });

  it('leaves a call whose arguments have not arrived exactly as the agent titled it', () => {
    // Codex announces an edit before it says which file. Nothing here can say
    // more than "Editing files" does, so nothing here tries: the row keeps the
    // title, and ACP's kind still gives it the mark and the colour.
    const row = rowFor(
      said({
        type: 'tool.started',
        toolCallId: 'edit-1',
        name: 'Editing files',
        input: {},
        title: 'Editing files',
        parentToolCallId: null,
        acpKind: 'edit',
      }),
    );
    render(<ToolRow item={row} nested={false} />);
    expect(screen.getByTestId('tool-row')).toHaveAttribute('data-ran-kind', 'edit');
    expect(screen.getByTestId('tool-row').textContent).toContain('Editing files');
  });
});
