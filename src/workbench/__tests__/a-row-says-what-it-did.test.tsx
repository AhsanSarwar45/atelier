/**
 * A command row says in English what the command did, behind a mark coloured
 * for the kind of thing it was, and the shell text is only there once the
 * reader has opened it.
 *
 * What this replaces: every row was the raw line, so `bd close bw-7dqe.1` and
 * `bd show bw-7dqe.1` were the same shape at a glance and an `rm -rf` two links
 * into a chain was the same shape as both (bw-7ks.24).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ToolRow } from '@/workbench/transcript-rows';
import type { TranscriptItem } from '@/workbench/use-session';

/** One finished call as the transcript holds it. */
const call = (name: string, input: Record<string, unknown>, title?: string): Extract<TranscriptItem, { kind: 'tool' }> => ({
  kind: 'tool',
  id: `t-${name}-${JSON.stringify(input)}`,
  name,
  // What the sidecar titled it. A named row must not be reading this.
  title: title ?? String(input.command ?? name),
  status: 'ok',
  seconds: 0,
  summary: null,
  parentId: null,
  diff: null,
  input,
  output: 'done',
});

/** A shell row, drawn. */
const shell = (command: string) => {
  const drawn = render(<ToolRow item={call('Bash', { command })} nested={false} />);
  return { ...drawn, row: screen.getByTestId('tool-row'), line: screen.getByTestId('tool-toggle') };
};

describe('the row says it in English', () => {
  it('holds no shell text on the line the reader sees', () => {
    // One per family, so this is not one command's good luck.
    const named: [string, string][] = [
      ['bd close bw-7dqe.1', 'Closed bw-7dqe.1'],
      ['git commit -m "fix the thing"', 'Committed'],
      ['rg -n "toolTitle" src', 'Searched for toolTitle in src'],
      ['npm test', 'Ran the tests'],
      ['cargo build --release', 'Built the Rust'],
    ];
    for (const [command, sentence] of named) {
      const { line, unmount } = shell(command);
      expect(line.textContent, command).toContain(sentence);
      // Not the command, and not the head word it opened with either.
      expect(line.textContent, command).not.toContain(command);
      expect(line.textContent, command).not.toContain(command.split(' ')[0]!);
      unmount();
    }
  });

  it('gives the reader the command itself the moment he opens the row', () => {
    const { line } = shell('bd close bw-7dqe.1');
    expect(screen.queryByTestId('tool-input')).toBeNull();
    fireEvent.click(line);
    expect(screen.getByTestId('tool-input').textContent).toContain('bd close bw-7dqe.1');
  });

  it('leaves a command no rule knows in the words it was typed in', () => {
    // His ruling: a row nobody can name reads exactly as it does today
    // rather than as a worse guess.
    const { line } = shell('frobnicate --sideways');
    expect(line.textContent).toContain('frobnicate --sideways');
    expect(screen.getByTestId('tool-row')).not.toHaveAttribute('data-ran-kind');
    expect(screen.queryByTestId('tool-mark')).toBeNull();
  });

  it('says it for a call that was never a command at all', () => {
    render(<ToolRow item={call('Read', { file_path: '/home/x/dev/beads-web/src/app/page.tsx' })} nested={false} />);
    expect(screen.getByTestId('tool-toggle').textContent).toContain('Read app/page.tsx');
    expect(screen.getByTestId('tool-row')).toHaveAttribute('data-ran-kind', 'read');
  });
});

describe('the mark says what kind of thing it was', () => {
  it('survives while the opening window defers the command body', () => {
    const item = {
      ...call('Bash', {}, 'Built the app'),
      detailsDeferred: true,
      ranKind: 'build' as const,
    };
    render(<ToolRow item={item} nested={false} sessionId="s" />);
    expect(screen.getByTestId('tool-mark')).toBeInTheDocument();
    expect(screen.getByTestId('tool-row')).toHaveAttribute('data-ran-kind', 'build');
    expect(screen.getByTestId('tool-toggle')).toHaveTextContent('Built the app');
  });

  it('draws a different mark for a different kind', () => {
    const { unmount } = shell('rg -n "hello" src');
    const looking = screen.getByTestId('tool-mark').outerHTML;
    expect(screen.getByTestId('tool-row')).toHaveAttribute('data-ran-band', 'looking');
    unmount();

    render(<ToolRow item={call('Bash', { command: 'bd close bw-7dqe.1' })} nested={false} />);
    const board = screen.getByTestId('tool-mark').outerHTML;
    expect(screen.getByTestId('tool-row')).toHaveAttribute('data-ran-band', 'board');
    // Both the shape and the colour, because either alone can go stale.
    expect(board).not.toBe(looking);
    expect(board).toContain('text-epic');
    expect(looking).toContain('text-t-secondary');
  });

  it('draws a delete in red wherever in the chain the delete was', () => {
    // The row mostly ran the tests. What it must not read as is a test run.
    const { row } = shell('npm test && rm -rf node_modules/.cache');
    expect(row).toHaveAttribute('data-ran-kind', 'grave');
    expect(row).toHaveAttribute('data-grave', 'yes');
    expect(screen.getByTestId('tool-mark').getAttribute('class')).toContain('text-danger');
    expect(screen.getByTestId('tool-toggle').textContent).toContain('deleted node_modules/.cache');
  });

  it('draws one in red where the delete is buried where no parse can see it', () => {
    const { row } = shell('find . -name "*.tmp" -exec rm {} \\;');
    expect(row).toHaveAttribute('data-grave', 'yes');
    expect(screen.getByTestId('tool-mark').getAttribute('class')).toContain('text-danger');
    expect(screen.getByTestId('tool-toggle').textContent).toContain('deleted files');
  });

  it('leaves a gate that deleted nothing in its own colour', () => {
    const { row } = shell('npm test');
    expect(row).not.toHaveAttribute('data-grave');
    expect(screen.getByTestId('tool-mark').getAttribute('class')).toContain('text-warning');
  });
});
