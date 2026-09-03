/** Regression coverage for the optical centering of compact workbench UI. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ProviderBadge } from '@/workbench/brand-icon';
import { WhatItRuns } from '@/workbench/what-it-runs';

const source = (name: string) => readFileSync(resolve(__dirname, `../${name}`), 'utf8');

/** The chip's own correction, spelled once in `src/components/ui/badge.tsx`. */
const SHARED = '[&>span:not([data-slot])]:top-px';

describe('compact workbench vertical alignment', () => {
  it('uses the same icon scale and gap on status badges', () => {
    render(<>
      <ProviderBadge brand="codex" />
      <WhatItRuns model="gpt-5.6-sol" permissionMode="default" models={[]} />
    </>);

    const provider = screen.getByTestId('session-brand');
    expect(provider.className).toContain('gap-1');
    expect(provider.querySelector('svg')?.classList).toContain('size-3');
  });

  /**
   * The correction is the chip's, not each caller's.
   *
   * Every one of these labels used to carry its own `relative top-px`, so a
   * chip was centred if and only if whoever wrote it had noticed — and the
   * ones nobody had noticed (the file chips in a message) drew their letters a
   * pixel above the middle of the pill. Asserting the shared rule is on the
   * badge and the hand copies are gone is what stops the fifth caller
   * rediscovering it (bw-s5op.1).
   */
  it('centers chip labels from the shared badge rather than caller by caller', () => {
    render(<>
      <ProviderBadge brand="codex" />
      <WhatItRuns model="gpt-5.6-sol" permissionMode="default" effort="high" models={[]} />
    </>);

    for (const id of ['session-brand', 'chat-model-chip', 'chat-mode-chip', 'chat-effort-chip']) {
      const chip = screen.getByTestId(id);
      expect(chip.className, `${id} must inherit the shared correction`).toContain(SHARED);
      expect(chip.querySelector('span')?.className ?? '', `${id} must not nudge its own label`).not.toContain('top-px');
    }
  });

  it('keeps the folder badge in the shared typeface and optically centers row labels', () => {
    const tab = source('chat-tab.tsx');
    const transcript = source('transcript-rows.tsx');

    expect(tab).toContain('max-w-40 shrink-0 gap-1 truncate');
    expect(tab).toContain('className="min-w-0 truncate">{facts.folder}');
    // Not a chip: this label is a button's, and the shared badge rule cannot
    // reach it, so its own correction stays where it is.
    expect(transcript).toContain('<span className="relative top-px truncate">');
  });

  it('spells the correction in exactly one place', () => {
    const badge = readFileSync(resolve(__dirname, '../../components/ui/badge.tsx'), 'utf8');
    expect(badge).toContain(SHARED);
    for (const name of ['brand-icon.tsx', 'what-it-runs.tsx', 'chat-tab.tsx']) {
      const withoutComments = source(name).replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
      expect(withoutComments, `${name} must not hand-nudge a chip label`).not.toContain('relative top-px');
    }
  });
});
