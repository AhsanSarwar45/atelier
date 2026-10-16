import { describe, expect, it } from 'vitest';

import type { StorageRule } from '@/lib/api';
import { bytesWords, conflicts, ruleTitle } from '@/workbench/storage-rules';

const rule = (id: string, amount: number, del: StorageRule['delete'], more: Partial<StorageRule> = {}): StorageRule => ({
  id,
  enabled: true,
  amount,
  unit: 'days',
  delete: del,
  projectId: null,
  ...more,
});

describe('storage rule conflicts', () => {
  it('flags an images rule that a younger chat rule already covers', () => {
    const found = conflicts([rule('c', 30, 'chats'), rule('i', 60, 'images')]);
    expect(found.get('i')).toMatchObject({ by: 'c', kind: 'covered', message: 'No effect. Rule 1 already deletes these chats.' });
    expect(found.has('c')).toBe(false);
  });

  it('leaves an images rule younger than the chat rule alone', () => {
    expect(conflicts([rule('c', 90, 'chats'), rule('i', 30, 'images')]).size).toBe(0);
  });

  it('flags only the later of two identical rules', () => {
    const found = conflicts([rule('a', 4, 'images', { unit: 'weeks' }), rule('b', 28, 'images')]);
    expect(found.get('b')).toMatchObject({ by: 'a', kind: 'duplicate', message: 'Same as rule 1.' });
    expect(found.has('a')).toBe(false);
  });

  it('does not let a one-project rule cover an all-projects rule', () => {
    const found = conflicts([rule('p', 7, 'chats', { projectId: 'x' }), rule('all', 30, 'chats')]);
    expect(found.size).toBe(0);
    expect(conflicts([rule('all', 7, 'chats'), rule('p', 30, 'images', { projectId: 'x' })]).get('p')?.kind).toBe('covered');
  });

  it('lets a delete rule take archives but not the other way round', () => {
    expect(conflicts([rule('a', 30, 'archive'), rule('d', 365, 'chats')]).size).toBe(0);
    expect(conflicts([rule('d', 30, 'chats'), rule('a', 90, 'archive')]).get('a')?.message).toBe(
      'No effect. Rule 1 already deletes these chats.',
    );
    expect(conflicts([rule('a', 30, 'archive'), rule('t', 60, 'output')]).get('t')?.message).toBe(
      'No effect. Rule 1 already archives these chats.',
    );
  });

  it('flags an archive rule a delete rule of the same age empties', () => {
    const found = conflicts([rule('a', 30, 'archive'), rule('d', 30, 'chats')]);
    expect(found.get('a')?.message).toBe('No effect. Rule 2 already deletes these chats.');
    expect(found.has('d')).toBe(false);
  });

  it('ignores turned-off rules and keeps images and files apart', () => {
    expect(conflicts([rule('c', 1, 'chats', { enabled: false }), rule('i', 60, 'images')]).size).toBe(0);
    expect(conflicts([rule('i', 1, 'images'), rule('f', 60, 'files')]).size).toBe(0);
  });
});

describe('storage words', () => {
  it('reads a rule as one line and sizes as people write them', () => {
    expect(ruleTitle(rule('a', 1, 'files', { unit: 'months' }))).toBe('Delete files in chats older than 1 month');
    expect(ruleTitle(rule('a', 2, 'output', { unit: 'weeks' }))).toBe('Trim tool output in chats older than 2 weeks');
    expect(bytesWords(512)).toBe('512 B');
    expect(bytesWords(1536)).toBe('1.5 KB');
    expect(bytesWords(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(bytesWords(300 * 1024 ** 2)).toBe('300 MB');
  });
});
