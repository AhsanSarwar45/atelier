import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ThinkingBlock } from '@/workbench/transcript-rows';

describe('a thought block', () => {
  it('trims provider separators and renders the complete body as Markdown', () => {
    render(<ThinkingBlock item={{
      kind: 'thinking',
      id: 'thought',
      text: '\n\n**Assessing service check behavior**\n\nThe complete thought stays readable.\n\n- First detail\n- Second detail\n\n',
      done: true,
      parentId: null,
    }} />);

    fireEvent.click(screen.getByTestId('thinking-toggle'));
    const thought = within(screen.getByTestId('thinking-block'));
    expect(thought.getByText('Assessing service check behavior').tagName).toBe('STRONG');
    expect(thought.getAllByRole('listitem')).toHaveLength(2);
    expect(thought.getByText('The complete thought stays readable.')).toBeInTheDocument();
    expect(screen.getByTestId('thinking-block')).not.toHaveTextContent('**');
  });
});
