import { describe, expect, it } from 'vitest';

import { candidatesFrom, reportFrom } from '@/workbench/link-rules';

/**
 * The rule these guard is deliberately mean: a chip for a card the chat never
 * touched is worse than a missed one, so every "mention" case below must stay
 * empty. Confirmation against the board is a second guard, not this one's job.
 */
describe('what counts as touching a card', () => {
  it('takes ids a bd command names', () => {
    expect(candidatesFrom('Bash', { command: 'bd show bw-7ks' })).toEqual(['bw-7ks']);
    expect(candidatesFrom('Bash', { command: 'bd note cor-dlby.6 "done"' })).toEqual(['cor-dlby.6']);
  });

  it('follows a chain and a leading environment assignment', () => {
    expect(candidatesFrom('Bash', { command: 'cd /x && bd close pz-aaa111 && echo ok' })).toEqual(['pz-aaa111']);
    expect(candidatesFrom('Bash', { command: 'BEADS_ACTOR=me bd dep add aa-111 bb-222' })).toEqual(['aa-111', 'bb-222']);
  });

  it('ignores an id that is merely mentioned', () => {
    expect(candidatesFrom('Bash', { command: 'grep -r bw-7ks docs/' })).toEqual([]);
    expect(candidatesFrom('Bash', { command: 'echo "see bw-7ks" > /tmp/f' })).toEqual([]);
    expect(candidatesFrom('Bash', { command: 'cat notes-about-bw-7ks.md' })).toEqual([]);
  });

  it('does not mistake another command for bd', () => {
    expect(candidatesFrom('Bash', { command: 'abd show bw-7ks' })).toEqual([]);
    expect(candidatesFrom('Bash', { command: 'sbd list cor-abc1' })).toEqual([]);
  });

  it('reading is not acting', () => {
    expect(candidatesFrom('Read', { file_path: '/p/docs/bw-7ks.md' })).toEqual([]);
    expect(candidatesFrom('Grep', { pattern: 'bw-7ks' })).toEqual([]);
  });

  it('takes an id from the path of a file the agent wrote', () => {
    expect(candidatesFrom('Edit', { file_path: '/p/docs/handoff/bw-7ks.md' })).toEqual(['bw-7ks']);
    expect(candidatesFrom('Write', { file_path: '/p/.beads/cor-abc1.jsonl' })).toEqual(['cor-abc1']);
  });

  it('wants the whole stem, not an id buried in a longer name', () => {
    expect(candidatesFrom('Edit', { file_path: '/p/docs/notes-about-bw-7ks.md' })).toEqual([]);
    expect(candidatesFrom('Edit', { file_path: '/p/src/notes.txt' })).toEqual([]);
  });
});

describe('spotting a report', () => {
  it('recognises a spec being written', () => {
    expect(reportFrom('Write', { file_path: '/h/reporting/pages/beads-web/my-slug.report.json' })).toEqual({
      project: 'beads-web',
      slug: 'my-slug',
    });
  });

  it('ignores the built page and anything else', () => {
    expect(reportFrom('Write', { file_path: '/h/reporting/pages/x/y.html' })).toBeNull();
    expect(reportFrom('Write', { file_path: '/p/notes.json' })).toBeNull();
    expect(reportFrom('Read', { file_path: '/h/reporting/pages/x/y.report.json' })).toBeNull();
  });
});
