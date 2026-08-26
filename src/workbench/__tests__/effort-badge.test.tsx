import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { WhatItRuns } from '@/workbench/what-it-runs';

describe('the active effort in the chat status line', () => {
  it('draws the provider-announced label as an accessible badge', () => {
    render(
      <WhatItRuns
        model="opus"
        permissionMode="default"
        models={[{ value: 'opus', displayName: 'Opus' }]}
        effort="xhigh"
        efforts={[{ value: 'xhigh', displayName: 'Extra high' }]}
      />,
    );

    const badge = screen.getByTestId('chat-effort-chip');
    expect(badge).toHaveTextContent('Extra high');
    expect(badge).toHaveAttribute('data-effort', 'xhigh');
    expect(badge).toHaveAttribute('title', 'Reasoning effort — Extra high');
  });

  it('draws no effort badge when the provider has not reported an active value', () => {
    render(<WhatItRuns model={null} permissionMode={null} models={[]} efforts={[]} />);
    expect(screen.queryByTestId('chat-effort-chip')).toBeNull();
  });
});
