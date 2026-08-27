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

  it('keeps a newly introduced provider value readable before this app knows it', () => {
    render(<WhatItRuns model={null} permissionMode={null} models={[]} effort="extra_deep" efforts={[]} />);
    expect(screen.getByTestId('chat-effort-chip')).toHaveTextContent('Extra deep');
  });
});

describe('the active collaboration mode in the chat status line', () => {
  it('uses the provider-announced name and keeps it distinct from permissions', () => {
    render(
      <WhatItRuns
        model="gpt-5.6-sol"
        permissionMode="on-request"
        models={[]}
        collaborationMode="plan"
        collaborationModes={[{ value: 'default', displayName: 'Default' }, { value: 'plan', displayName: 'Plan' }]}
      />,
    );

    expect(screen.getByTestId('chat-mode-chip')).toHaveTextContent('On request');
    const collaboration = screen.getByTestId('chat-collaboration-mode-chip');
    expect(collaboration).toHaveTextContent('Plan');
    expect(collaboration).toHaveAttribute('data-collaboration-mode', 'plan');
  });

  it('draws no collaboration badge for providers that announce none', () => {
    render(<WhatItRuns model={null} permissionMode={null} models={[]} />);
    expect(screen.queryByTestId('chat-collaboration-mode-chip')).toBeNull();
  });
});
