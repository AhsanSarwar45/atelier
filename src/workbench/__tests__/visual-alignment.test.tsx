/** Regression coverage for the optical centering of compact workbench UI. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ProviderBadge } from '@/workbench/brand-icon';
import { WhatItRuns } from '@/workbench/what-it-runs';

const source = (name: string) => readFileSync(resolve(__dirname, `../${name}`), 'utf8');

describe('compact workbench vertical alignment', () => {
  it('uses the same icon scale, gap, and optical text correction on status badges', () => {
    render(<>
      <ProviderBadge brand="codex" />
      <WhatItRuns model="gpt-5.6-sol" permissionMode="default" models={[]} />
    </>);

    const provider = screen.getByTestId('session-brand');
    expect(provider.className).toContain('gap-1');
    expect(provider.querySelector('svg')?.classList).toContain('size-3');
    expect(provider.querySelector('span')?.className).toContain('top-px');
    expect(screen.getByTestId('chat-model-chip').querySelector('span')?.className).toContain('top-px');
    expect(screen.getByTestId('chat-mode-chip').querySelector('span')?.className).toContain('top-px');
  });

  it('keeps the folder badge in the shared typeface and optically centers row labels', () => {
    const tab = source('chat-tab.tsx');
    const transcript = source('transcript-rows.tsx');

    expect(tab).toContain('max-w-40 shrink-0 gap-1 truncate');
    expect(tab).toContain('className="relative top-px min-w-0 truncate">{facts.folder}');
    expect(transcript).toContain('<span className="relative top-px truncate">');
  });
});
