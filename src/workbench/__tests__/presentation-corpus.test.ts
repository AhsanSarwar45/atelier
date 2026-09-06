import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { presentableWidget, widget } from '@/workbench/chat-widgets';
import { visualArtifact } from '@/workbench/visual-artifacts';

/**
 * The reader's half of the shared contract. The presenter answers the same
 * corpus in `server/tests/presentation_corpus.rs`; a case that the two answer
 * differently is the bug this corpus exists to catch, so both files read the
 * one fixture rather than each keeping a list of their own.
 */
type Case = { name: string; verdict: 'accept' | 'refuse'; why: string; payload: unknown };

const corpus = JSON.parse(
  readFileSync('tests/fixtures/presentation-corpus.json', 'utf8'),
) as { widgets: Case[]; artifacts: Case[] };

describe('presentation corpus, read by the reader', () => {
  it('is not empty and answers both ways', () => {
    expect(corpus.widgets.length).toBeGreaterThan(50);
    expect(corpus.widgets.some((one) => one.verdict === 'accept')).toBe(true);
    expect(corpus.widgets.some((one) => one.verdict === 'refuse')).toBe(true);
  });

  it.each(corpus.widgets.map((one) => [one.name, one] as const))(
    'reads %s the way the corpus records it',
    (_name, one) => {
      expect(presentableWidget(one.payload) !== null).toBe(one.verdict === 'accept');
    },
  );

  // Accepting a payload is only worth anything if the transcript then draws it.
  it.each(
    corpus.widgets.filter((one) => one.verdict === 'accept').map((one) => [one.name, one] as const),
  )('draws %s, which the corpus accepts', (_name, one) => {
    expect(widget(one.payload)).not.toBeNull();
  });
});

describe('artifact corpus, read by the reader', () => {
  it('is not empty and answers both ways', () => {
    expect(corpus.artifacts.length).toBeGreaterThan(20);
    expect(corpus.artifacts.some((one) => one.verdict === 'accept')).toBe(true);
    expect(corpus.artifacts.some((one) => one.verdict === 'refuse')).toBe(true);
  });

  it.each(corpus.artifacts.map((one) => [one.name, one] as const))(
    'reads %s the way the corpus records it',
    (_name, one) => {
      expect(visualArtifact(one.payload) !== null).toBe(one.verdict === 'accept');
    },
  );
});
