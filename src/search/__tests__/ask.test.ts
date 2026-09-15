import { describe, expect, it } from 'vitest';

import { type AskEvent, events } from '@/search/ask';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function all(body: ReadableStream<Uint8Array>): Promise<AskEvent[]> {
  const seen: AskEvent[] = [];
  for await (const event of events(body)) seen.push(event);
  return seen;
}

describe('the AI search reply', () => {
  it('is read one object per line however the bytes are split', async () => {
    const seen = await all(
      streamOf([
        '{"type":"started","provider":"claude","mo',
        'del":null}\n{"type":"st',
        'ep","text":"a"}\n\n',
        '{"type":"done","dropped":1}',
      ]),
    );
    expect(seen).toEqual([
      { type: 'started', provider: 'claude', model: null },
      { type: 'step', text: 'a' },
      { type: 'done', dropped: 1 },
    ]);
  });

  it('keeps a character split across two chunks whole', async () => {
    const bytes = new TextEncoder().encode('{"type":"step","text":"café"}\n');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, bytes.length - 4));
        controller.enqueue(bytes.slice(bytes.length - 4));
        controller.close();
      },
    });
    expect(await all(body)).toEqual([{ type: 'step', text: 'café' }]);
  });
});
