/**
 * A picker you can type into (bw-ov7a.7).
 *
 * What matters here is that a name the reader already knows is reachable by
 * typing it: the filter narrows on every word, the arrow keys walk what is
 * left, and Enter takes the row they are on.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Picker, matchingChoices, type PickerChoice } from '@/components/ui/picker';

const BRANCHES: PickerChoice[] = [
  { value: 'main', label: 'main' },
  { value: 'ours', label: 'ours' },
  { value: 'bw-ov7a.7', label: 'bw-ov7a.7', hint: 'a searchable picker' },
  { value: 'bw-kl4k.1', label: 'bw-kl4k.1', hint: 'a sent-away card' },
];

describe('what typing leaves', () => {
  it('leaves everything when nothing is typed', () => {
    expect(matchingChoices(BRANCHES, '')).toHaveLength(4);
    expect(matchingChoices(BRANCHES, '   ')).toHaveLength(4);
  });

  it('matches part of a name, in any case', () => {
    expect(matchingChoices(BRANCHES, 'OV7A').map((choice) => choice.value)).toEqual(['bw-ov7a.7']);
    expect(matchingChoices(BRANCHES, 'bw-').map((choice) => choice.value)).toEqual([
      'bw-ov7a.7',
      'bw-kl4k.1',
    ]);
  });

  it('matches the hint and the hidden keywords too', () => {
    expect(matchingChoices(BRANCHES, 'sent-away').map((choice) => choice.value)).toEqual([
      'bw-kl4k.1',
    ]);
    const trees = [{ value: '/home/dev/app/worktrees/bw-1', label: 'bw-1', keywords: '/home/dev/app/worktrees/bw-1' }];
    expect(matchingChoices(trees, 'worktrees')).toHaveLength(1);
  });

  it('needs every word, in whatever order they were typed', () => {
    expect(matchingChoices(BRANCHES, 'picker searchable').map((c) => c.value)).toEqual(['bw-ov7a.7']);
    expect(matchingChoices(BRANCHES, 'picker sent-away')).toEqual([]);
  });

  it('keeps the order it was given', () => {
    expect(matchingChoices(BRANCHES, 'b').map((choice) => choice.value)).toEqual([
      'bw-ov7a.7',
      'bw-kl4k.1',
    ]);
  });
});

describe('the picker on a screen', () => {
  function draw(value = 'main') {
    const onChange = vi.fn();
    render(
      <Picker
        data-testid="branch"
        label="Branch"
        value={value}
        onChange={onChange}
        choices={BRANCHES}
        empty="No branch matches"
      />,
    );
    return onChange;
  }

  it('shows the chosen name until it is opened', () => {
    draw('bw-kl4k.1');
    expect(screen.getByTestId('branch')).toHaveTextContent('bw-kl4k.1');
    expect(screen.queryByTestId('branch-search')).toBeNull();
  });

  it('narrows the list as the reader types', () => {
    draw();
    fireEvent.click(screen.getByTestId('branch'));
    expect(screen.getAllByRole('option')).toHaveLength(4);
    fireEvent.change(screen.getByTestId('branch-search'), { target: { value: 'kl4k' } });
    const left = screen.getAllByRole('option');
    expect(left).toHaveLength(1);
    expect(left[0]).toHaveTextContent('bw-kl4k.1');
  });

  it('says so when nothing matches', () => {
    draw();
    fireEvent.click(screen.getByTestId('branch'));
    fireEvent.change(screen.getByTestId('branch-search'), { target: { value: 'nothing here' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByTestId('branch-empty')).toHaveTextContent('No branch matches');
  });

  it('takes the row the arrow keys are on when Enter is pressed', () => {
    const onChange = draw();
    fireEvent.click(screen.getByTestId('branch'));
    const search = screen.getByTestId('branch-search');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('ours');
  });

  it('walks the filtered list, not the whole one', () => {
    const onChange = draw();
    fireEvent.click(screen.getByTestId('branch'));
    const search = screen.getByTestId('branch-search');
    fireEvent.change(search, { target: { value: 'bw-' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('bw-kl4k.1');
  });

  it('wraps around rather than stopping at the ends', () => {
    const onChange = draw();
    fireEvent.click(screen.getByTestId('branch'));
    const search = screen.getByTestId('branch-search');
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('bw-kl4k.1');
  });

  it('takes a row that is clicked', () => {
    const onChange = draw();
    fireEvent.click(screen.getByTestId('branch'));
    fireEvent.click(screen.getByText('ours'));
    expect(onChange).toHaveBeenCalledWith('ours');
  });

  it('marks the chosen row so the reader can see which one it is', () => {
    draw('ours');
    fireEvent.click(screen.getByTestId('branch'));
    const chosen = screen.getAllByRole('option').filter((row) => row.getAttribute('aria-selected') === 'true');
    expect(chosen).toHaveLength(1);
    expect(chosen[0]).toHaveTextContent('ours');
  });

  it('cannot be opened when it is disabled', () => {
    render(<Picker data-testid="off" value="" onChange={vi.fn()} choices={BRANCHES} disabled />);
    const trigger = screen.getByTestId('off');
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.queryByTestId('off-search')).toBeNull();
  });

  it('starts each opening with an empty search', () => {
    draw();
    fireEvent.click(screen.getByTestId('branch'));
    fireEvent.change(screen.getByTestId('branch-search'), { target: { value: 'kl4k' } });
    fireEvent.click(screen.getByText('bw-kl4k.1'));
    fireEvent.click(screen.getByTestId('branch'));
    expect(screen.getByTestId('branch-search')).toHaveValue('');
    expect(screen.getAllByRole('option')).toHaveLength(4);
  });
});
