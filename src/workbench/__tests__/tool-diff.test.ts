/**
 * The change a tool call carries.
 *
 * One rule for both halves of the app: the live watcher and the reading of a
 * past chat both take a change off the same arguments, so an edit made while
 * this app watched and the same edit read back out of the kit's record draw the
 * identical thing (bw-4wcd.1).
 */
import { describe, expect, it } from 'vitest';

import { diffOf, KEPT } from '@/workbench/imported-history';

describe('the change a call made', () => {
  it('reads an edit as what went out and what came in', () => {
    expect(diffOf('Edit', { file_path: '/w/a.ts', old_string: 'const a = 1', new_string: 'const a = 2' })).toEqual({
      path: '/w/a.ts',
      before: 'const a = 1',
      after: 'const a = 2',
    });
  });

  it('names the first line edited when the surrounding file is available', () => {
    expect(diffOf(
      'Edit',
      { file_path: '/w/a.ts', old_string: 'const a = 1', new_string: 'const a = 2' },
      'import x from "x";\n\nconst a = 1;\n',
    )).toMatchObject({ line: 3 });
  });

  it('reads a written file as an addition with nothing before it', () => {
    expect(diffOf('Write', { file_path: '/w/new.ts', content: 'hello' })).toEqual({
      path: '/w/new.ts',
      before: '',
      after: 'hello',
      line: 1,
    });
  });

  it('runs the several edits of one call together, in the order they were made', () => {
    expect(
      diffOf('MultiEdit', {
        file_path: '/w/a.ts',
        edits: [
          { old_string: 'one', new_string: 'ONE' },
          { old_string: 'two', new_string: 'TWO' },
        ],
      }),
    ).toEqual({ path: '/w/a.ts', before: 'one\ntwo', after: 'ONE\nTWO' });
  });

  it('says nothing for a call that changed no file', () => {
    expect(diffOf('Bash', { command: 'ls' })).toBeNull();
    expect(diffOf('Read', { file_path: '/w/a.ts' })).toBeNull();
    expect(diffOf('Edit', { old_string: 'a', new_string: 'b' })).toBeNull();
    expect(diffOf('MultiEdit', { file_path: '/w/a.ts', edits: [] })).toBeNull();
  });

  it('cuts a whole file to the one length every body is cut to', () => {
    const change = diffOf('Write', { file_path: '/w/big.ts', content: 'x'.repeat(KEPT * 2) })!;
    expect(change.after.length).toBeLessThan(KEPT + 60);
    expect(change.after).toContain('more characters');
  });
});
