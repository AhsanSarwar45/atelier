import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { enterSubmits } from '@/workbench/chat-tab';

const source = (relative: string) => readFileSync(resolve(__dirname, relative), 'utf8');

describe('the mobile chat composer', () => {
  it('reserves submission for the send button on a phone', () => {
    expect(enterSubmits({ key: 'Enter', shiftKey: false } as never, true)).toBe(false);
    expect(enterSubmits({ key: 'Enter', shiftKey: false } as never, false)).toBe(true);
    expect(enterSubmits({ key: 'Enter', shiftKey: true } as never, false)).toBe(false);
  });

  it('replaces the three cramped inline selectors with one settings dialog', () => {
    const chat = source('../chat-tab.tsx');
    expect(chat).toContain('data-testid="desktop-composer-settings"');
    expect(chat).toContain('data-testid="mobile-composer-settings"');
    expect(chat).toContain('data-testid="mobile-composer-settings-dialog"');
    expect(chat).toContain('testid="mobile-mode-picker"');
    expect(chat).toContain('testid="mobile-model-picker"');
    expect(chat).toContain('testid="mobile-effort-picker"');
    expect(chat).not.toContain('Choose how this chat runs before sending your next message.');
  });
});

describe('the mobile chat chrome', () => {
  it('keeps only context and plan usage visible in the status bar', () => {
    const chat = source('../chat-tab.tsx');
    const provider = chat.split('\n').find((line) => line.includes('<ProviderBadge brand={sessionBrand}')) ?? '';
    expect(provider).toContain('className="hidden md:inline-flex"');
    expect(chat.slice(chat.indexOf('<WhatItRuns'), chat.indexOf('/>', chat.indexOf('<WhatItRuns')))).toContain('className="hidden md:flex"');
    expect(chat).not.toContain('data-testid="cost-chip"');
    expect(chat.slice(chat.indexOf('<ContextChip'), chat.indexOf('<PlanChip'))).not.toContain('md:hidden');
  });

  /**
   * One question decides, and the composer row asks it of itself
   * (bw-e3dw.11, then bw-e3dw.12).
   *
   * bw-e3dw.11 found these rows switching at `sm` while every sheet in the app
   * switched at `md`, so between 640 and 767 the rails were a phone's and the
   * composer was a desktop's. Driven at 700px with a chat that has every
   * steering control a Claude session offers, the desktop row did not fit:
   * 656px of pickers in the 634px it had, with "2 agents" printed over
   * "Enabled" and the send button over both. `enterSubmits` had already been
   * asking `isPhoneScreen()` — `md` — what to do with the Enter key at that
   * width, so the CSS was the only part of the composer still saying `sm`. It
   * moved to `md`, and `sm:` must not come back: that is the first assertion
   * here and it has not changed.
   *
   * bw-e3dw.12 then found that `md` was not enough for the TOOL ROW, and why.
   * Above 768 the two rails stop being sheets and become 288px columns, so the
   * row is given what is left of the window rather than the window: 258px at a
   * 900px window and 458px at 1100px, against pickers that need 656. No media
   * query can see that, because the number a `min-width` reads is the window's.
   * So the row became a container — `[container-type:inline-size]` — and its
   * three switches now ask `composer-wide:`, which is that container query
   * spelled once in `tailwind.config.ts`.
   *
   * That is not a retreat from bw-e3dw.11's decision, and this case is what
   * keeps the two coherent. `composer-wide:` gives the same answer as `md:` at
   * every width where the rails are sheets and the row IS the window, which is
   * everywhere bw-e3dw.11 measured; it differs only where the rails are
   * columns, which is where the fault was. The STATUS line, which fits at every
   * width measured, still asks `md:` and is checked above — one question each,
   * and neither row carries two answers.
   */
  it('switches on whether the row has room, and never on `sm` again', () => {
    const chat = source('../chat-tab.tsx');
    expect(chat, 'a second answer to "is this a phone" is back on the composer row').not.toMatch(
      /\bsm:(hidden|flex|inline-flex)\b/,
    );

    // The row is the container, so what its children measure is the row.
    const row = chat.indexOf('[container-name:composer] [container-type:inline-size]');
    expect(row, 'the composer tool row is no longer a container for its own children').toBeGreaterThan(-1);

    // All three switches on the row ask that container and not the window.
    const settings = chat.indexOf('data-testid="desktop-composer-settings"');
    expect(chat.slice(settings - 80, settings)).toContain('composer-wide:flex');
    const phone = chat.indexOf('data-testid="mobile-composer-settings"');
    expect(chat.slice(phone, phone + 160)).toContain('composer-wide:hidden');
    const agents = chat.indexOf('data-testid="agent-definitions"');
    expect(chat.slice(agents, agents + 400)).toContain('composer-wide:inline-flex');

    // And the variant is defined in one place, with the width it was measured at.
    const tw = source('../../../tailwind.config.ts');
    expect(tw).toContain("addVariant('composer-wide'");
    expect(tw).toContain('@container composer (min-width:');
  });

  it('uses compact cards and equally tall inset toolbar controls', () => {
    expect(source('../transcript-rows.tsx')).toContain("px-2.5 py-1 font-mono text-xs md:py-1.5");
    expect(source('../../components/ui/tabs.tsx')).toContain('inline-flex h-12 items-center');
    expect(source('../../components/ui/tabs.tsx')).toContain('inline-flex h-10 items-center');
    const filter = source('../filter-tree.tsx');
    expect(filter).toContain('emphasis="quiet"');
    expect(filter).toContain("'h-10 w-10 sm:h-8 sm:w-8'");
  });
});
