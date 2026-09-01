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
    expect(provider).toContain('className="hidden sm:inline-flex"');
    expect(chat.slice(chat.indexOf('<WhatItRuns'), chat.indexOf('/>', chat.indexOf('<WhatItRuns')))).toContain('className="hidden sm:flex"');
    expect(chat.slice(chat.indexOf('data-testid="cost-chip"'), chat.indexOf('</Badge>', chat.indexOf('data-testid="cost-chip"')))).toContain('hidden font-mono sm:inline-flex');
    expect(chat.slice(chat.indexOf('<ContextChip'), chat.indexOf('<PlanChip'))).not.toContain('md:hidden');
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
