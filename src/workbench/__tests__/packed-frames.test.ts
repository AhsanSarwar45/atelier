/**
 * Frames that arrive gzipped.
 *
 * A phone opening a chat was sent every snapshot as plain text, and a
 * conversation's text is most of what crossed its Wi-Fi. A window that can
 * unpack now asks for large frames packed (server/src/routes/live.rs). Packed
 * frames take a moment to unpack, and a small text frame behind one must not
 * overtake it: the snapshot has to be drawn before the event that follows it.
 */
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tagged } from './tagged';

let opened: FakeSocket[] = [];

class FakeSocket {
  onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  binaryType = 'blob';

  constructor(readonly url: string) {
    opened.push(this);
  }

  close(): void {}
}

beforeEach(() => {
  opened = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a window that can unpack', () => {
  it('asks for packed frames and hears them in the order they were sent', async () => {
    vi.resetModules();
    const { onWorkbench } = await import('@/workbench/live-wire');
    const heard: string[] = [];
    onWorkbench({ frame: (data) => heard.push(data), dropped: () => {} });

    expect(opened).toHaveLength(1);
    expect(opened[0].url).toContain('pack=gzip');

    const packed = gzipSync(tagged('workbench', 'first, packed').data);
    opened[0].onmessage?.({ data: packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength) });
    opened[0].onmessage?.(tagged('workbench', 'second, as text'));

    await vi.waitFor(() => expect(heard).toHaveLength(2));
    expect(heard).toEqual(['first, packed', 'second, as text']);

    // Once nothing is waiting, text is handed on at once again.
    opened[0].onmessage?.(tagged('workbench', 'third'));
    expect(heard).toEqual(['first, packed', 'second, as text', 'third']);
  });
});
