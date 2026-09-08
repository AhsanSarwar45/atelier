import { describe, expect, it } from 'vitest';

import { addressWith, lineFrom, whereFrom } from '@/lib/address';

/**
 * The Files tab is a third destination, and the file and line it is showing ride
 * in the address beside the chat and the card (bw-g3o3.4). What is proved here
 * is everything a link can carry into it: that `tab=files` is a place the app
 * knows, that naming a file is enough to get there, and that a line nobody could
 * scroll to is dropped rather than handed on.
 */
describe('the address can name a file', () => {
  it('takes tab=files as a destination of its own', () => {
    expect(whereFrom(new URLSearchParams('id=p1&tab=files')).tab).toBe('files');
  });

  it('lands on the Files tab for a link that names only a file', () => {
    const where = whereFrom(new URLSearchParams('id=p1&file=/work/atelier/src/lib/address.ts&line=42'));
    expect(where.tab).toBe('files');
    expect(where.file).toBe('/work/atelier/src/lib/address.ts');
    expect(where.line).toBe(42);
  });

  it('still prefers the tab the address spells out over the one a file implies', () => {
    expect(whereFrom(new URLSearchParams('tab=chat&file=/work/a.ts')).tab).toBe('chat');
  });

  it('leaves the older destinations exactly where they were', () => {
    expect(whereFrom(new URLSearchParams('chat=s1')).tab).toBe('chat');
    expect(whereFrom(new URLSearchParams('')).tab).toBe('board');
    expect(whereFrom(new URLSearchParams('tab=reports')).tab).toBe('board');
  });

  it('keeps no file and no line when the address names neither', () => {
    const where = whereFrom(new URLSearchParams('id=p1&tab=board'));
    expect(where.file).toBeNull();
    expect(where.line).toBeNull();
  });

  // A line is counted from one, so anything else is somebody's slip and a viewer
  // told to go there would land somewhere quietly wrong.
  it('drops a line that is not a line', () => {
    expect(lineFrom('1')).toBe(1);
    expect(lineFrom('0')).toBeNull();
    expect(lineFrom('-3')).toBeNull();
    expect(lineFrom('2.5')).toBeNull();
    expect(lineFrom('banana')).toBeNull();
    expect(lineFrom('')).toBeNull();
    expect(lineFrom(null)).toBeNull();
    expect(whereFrom(new URLSearchParams('file=/work/a.ts&line=0')).line).toBeNull();
  });

  it('writes a file and a line back into an address a reader could have typed', () => {
    const address = addressWith(new URLSearchParams('id=p1&tab=board'), {
      tab: 'files',
      file: '/work/atelier/README.md',
      line: 7,
    });
    const written = new URLSearchParams(address.split('?')[1]);
    expect(written.get('tab')).toBe('files');
    expect(written.get('file')).toBe('/work/atelier/README.md');
    expect(written.get('line')).toBe('7');
    expect(written.get('id')).toBe('p1');
  });

  it('clears the file and the line when they are set to nothing', () => {
    const address = addressWith(new URLSearchParams('id=p1&tab=files&file=/work/a.ts&line=7'), {
      tab: 'chat',
      file: null,
      line: null,
    });
    const written = new URLSearchParams(address.split('?')[1]);
    expect(written.has('file')).toBe(false);
    expect(written.has('line')).toBe(false);
  });
});
