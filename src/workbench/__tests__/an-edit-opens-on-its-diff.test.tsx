/**
 * An edit row IS its diff: the card opens on it, holds it behind its own
 * click, and says nothing else.
 *
 * What this replaces: the diff was drawn under the card and outside it, so a
 * screen of changed lines could not be put away at all, and the card itself
 * held only the arguments the edit was handed and the sentence it printed —
 * the same change said twice, in worse words (bw-cso1.1).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ToolRow } from '@/workbench/transcript-rows';
import type { TranscriptItem } from '@/workbench/use-session';

const path = '/home/me/project/src/wheels.ts';

/** One finished edit as the transcript holds it. */
const edit: Extract<TranscriptItem, { kind: 'tool' }> = {
  kind: 'tool',
  id: 'edit-1',
  name: 'Edit',
  title: `Changed ${path}`,
  status: 'ok',
  seconds: 0,
  summary: null,
  parentId: null,
  input: { file_path: path, old_string: 'one', new_string: 'two' },
  output: 'The file has been updated.',
  diff: { path, before: 'one\n', after: 'two\n', line: 1 },
  ranKind: 'edit',
  ranGrave: false,
};

describe('an edit row opens on its diff', () => {
  it('draws the diff without a click', () => {
    render(<ToolRow item={edit} nested={false} />);
    expect(screen.getByTestId('tool-row')).toHaveAttribute('data-open', 'true');
    expect(screen.getByTestId('diff-view')).toBeInTheDocument();
  });

  it('puts the diff away when the reader shuts the row', () => {
    render(<ToolRow item={edit} nested={false} />);
    fireEvent.click(screen.getByTestId('tool-toggle'));
    expect(screen.getByTestId('tool-row')).toHaveAttribute('data-open', 'false');
    expect(screen.queryByTestId('diff-view')).toBeNull();
    // And back, because a row that cannot be reopened is not collapsed.
    fireEvent.click(screen.getByTestId('tool-toggle'));
    expect(screen.getByTestId('diff-view')).toBeInTheDocument();
  });

  it('holds the diff inside the card rather than beside it', () => {
    render(<ToolRow item={edit} nested={false} />);
    const card = screen.getByTestId('tool-toggle').parentElement!;
    expect(card).toContainElement(screen.getByTestId('diff-view'));
  });

  it('says nothing the diff already says', () => {
    render(<ToolRow item={edit} nested={false} />);
    expect(screen.queryByTestId('tool-input')).toBeNull();
    expect(screen.queryByTestId('tool-output')).toBeNull();
  });

  it('still opens a call with no diff on what it was asked and what it printed', () => {
    render(<ToolRow item={{ ...edit, diff: null, ranKind: undefined }} nested={false} />);
    expect(screen.getByTestId('tool-row')).toHaveAttribute('data-open', 'false');
    fireEvent.click(screen.getByTestId('tool-toggle'));
    expect(screen.getByTestId('tool-input')).toBeInTheDocument();
    expect(screen.getByTestId('tool-output')).toBeInTheDocument();
  });
});
