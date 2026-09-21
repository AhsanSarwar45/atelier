/**
 * The commits search box, read as a query (bw-g6zy.4).
 *
 * The typed line is the whole of the query: the popover writes qualifiers into
 * it and the chips take them out again, so everything that can go wrong with
 * two copies of a filter is asserted here, on the one thing there is.
 */
import { describe, expect, it } from 'vitest';

import {
  asLogQuery,
  isEmpty,
  readQuery,
  setFilters,
  withQualifier,
  words,
  writeQuery,
} from '@/workbench/commit-query';

describe('reading what was typed', () => {
  it('takes bare words as the message to search for', () => {
    expect(readQuery('fix the toast')).toEqual({ text: 'fix the toast' });
  });

  it('takes every qualifier it knows, and leaves the rest as words', () => {
    const query = readQuery('fix author:ahsan path:src/workbench ref:main sha:abc1234');

    expect(query.text).toBe('fix');
    expect(query.author).toBe('ahsan');
    expect(query.path).toBe('src/workbench');
    expect(query.ref).toBe('main');
    expect(query.sha).toBe('abc1234');
  });

  it('keeps a quoted value whole, because a date is several words', () => {
    expect(readQuery('since:"2 weeks ago" toast')).toMatchObject({
      since: '2 weeks ago',
      text: 'toast',
    });
  });

  it('leaves a colon it does not know as part of the message', () => {
    // Refusing to search for what was typed is worse than searching for a
    // little too much.
    expect(readQuery('see http://example.test/x')).toEqual({
      text: 'see http://example.test/x',
    });
    expect(readQuery('fix: the toast')).toEqual({ text: 'fix: the toast' });
    expect(readQuery('author:')).toEqual({ text: 'author:' });
  });

  it('splits on whitespace but not inside quotes, and tolerates an unclosed one', () => {
    expect(words('a "b c" d')).toEqual(['a', 'b c', 'd']);
    expect(words('a "b c')).toEqual(['a', 'b c']);
  });
});

describe('writing a query back out', () => {
  it('reads back as itself, quoting what has to be quoted', () => {
    const line = 'fix toast author:ahsan since:"2 weeks ago"';

    expect(writeQuery(readQuery(line))).toBe(line);
  });

  it('sets, replaces and removes one qualifier without touching the words', () => {
    let line = 'fix toast';

    line = withQualifier(line, 'author', 'ahsan');
    expect(line).toBe('fix toast author:ahsan');

    line = withQualifier(line, 'author', 'someone else');
    expect(line).toBe('fix toast author:"someone else"');

    line = withQualifier(line, 'author', undefined);
    expect(line).toBe('fix toast');

    // A value that is only spaces is no value at all.
    expect(withQualifier(line, 'path', '   ')).toBe('fix toast');
  });

  it('knows which filters are set, and when nothing is being asked for', () => {
    expect(isEmpty(readQuery('   '))).toBe(true);
    expect(isEmpty(readQuery('author:ahsan'))).toBe(false);
    expect(setFilters(readQuery('path:src author:ahsan')).map((f) => f.name)).toEqual([
      'author',
      'path',
    ]);
  });
});

describe('asking the server', () => {
  it('sends the words as the message search and the rest by name', () => {
    const asked = asLogQuery(readQuery('toast author:ahsan path:src since:yesterday'), 30, 30);

    expect(asked).toMatchObject({
      limit: 30,
      skip: 30,
      grep: 'toast',
      author: 'ahsan',
      file: 'src',
      since: 'yesterday',
    });
  });

  it('sends a pasted commit name as a name as well as as words', () => {
    // `--grep` never matches a commit's own name, so a person who pastes one
    // and is shown nothing has been told it is not there when it is.
    const asked = asLogQuery(readQuery('a1b2c3d4'), 30);

    expect(asked.grep).toBe('a1b2c3d4');
    expect(asked.sha).toBe('a1b2c3d4');
  });

  it('does not mistake an ordinary word for a commit name', () => {
    // Every letter of "added" is a hex digit, and the word is not a commit.
    expect(asLogQuery(readQuery('added'), 30).sha).toBeUndefined();
    expect(asLogQuery(readQuery('decade'), 30).sha).toBeUndefined();
    expect(asLogQuery(readQuery('toast'), 30).sha).toBeUndefined();
  });

  it('still lets a name be said outright, however short', () => {
    expect(asLogQuery(readQuery('sha:abc1 toast'), 30).sha).toBe('abc1');
  });

  it('leaves out what was never asked for, rather than sending it blank', () => {
    const asked = asLogQuery(readQuery(''), 30);

    expect(asked.grep).toBeUndefined();
    expect(asked.author).toBeUndefined();
    expect(asked.file).toBeUndefined();
  });
});
