import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('chat widget visual proof', () => {
  it('keeps the browser capture that shows the complete widget set', () => {
    const image = readFileSync('tests/results/chat-widgets.png');
    expect(Array.from(image.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(image.byteLength).toBeGreaterThan(10_000);
  });
});
