/**
 * @vitest-environment node
 *
 * A picture in a chat's record reaches the transcript as a picture.
 *
 * The transcript already knows how to draw one and open it full size — it has
 * done since the writing box grew an attachment tray. What it never got was a
 * picture out of a RECORD: reading a past chat produced the words alone, so the
 * manager's own message came back as the bare marker `[Image #1]` with nothing
 * behind it (bw-uu9x).
 *
 * So what is proved here is the same sameness the links are proved by: the
 * events a record produces for a spoken row are the events a live send would
 * have produced from the same turn — the picture announced against the same
 * message, before its words.
 */
import { describe, expect, it } from 'vitest';

import { IMPORT_RECIPE, pastTranscript } from '../../../src/workbench/imported-history.ts';
import { spokenAsEvents } from '../reading-back.ts';

/** A one-pixel PNG, small enough to write out here in full. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** One recorded message the way the agent kit writes a pasted picture down. */
function pastedInto(words: string) {
  return {
    type: 'user',
    message: {
      content: [
        { type: 'text', text: words },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PIXEL } },
      ],
    },
  };
}

/** The one spoken row a record of one message comes back as. */
function rowOf(record: { type: string; message: unknown }[]) {
  const row = pastTranscript(record)[0];
  if (!row || row.kind !== 'said') throw new Error('the record produced no spoken row');
  return row;
}

describe('opening a chat whose record holds a picture', () => {
  it('announces the picture against the message it was in', () => {
    const events = spokenAsEvents(rowOf([pastedInto('why is this broken [Image #1]')]), 'msg-1');
    expect(events.map((e) => e.type)).toEqual([
      'message.started',
      'image',
      'text.delta',
      'message.completed',
    ]);
    const picture = events.find((e) => e.type === 'image');
    expect(picture).toMatchObject({
      messageId: 'msg-1',
      image: { mime: 'image/png', dataUrl: `data:image/png;base64,${PIXEL}` },
    });
  });

  it('sends the picture before the words, as a picture just pasted is sent', () => {
    const types = spokenAsEvents(rowOf([pastedInto('look [Image #1]')]), 'msg-2').map((e) => e.type);
    expect(types.indexOf('image')).toBeLessThan(types.indexOf('text.delta'));
  });

  it('says nothing where the message was a picture and nothing else', () => {
    const record = [
      {
        type: 'user',
        message: {
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PIXEL } }],
        },
      },
    ];
    const types = spokenAsEvents(rowOf(record), 'msg-3').map((e) => e.type);
    expect(types).toEqual(['message.started', 'image', 'message.completed']);
  });

  it('leaves a message with no picture saying exactly what it always said', () => {
    const record = [{ type: 'user', message: { content: 'run the build' } }];
    const events = spokenAsEvents(rowOf(record), 'msg-4');
    expect(events.map((e) => e.type)).toEqual(['message.started', 'text.delta', 'message.completed']);
    expect(events[1]).toMatchObject({ text: 'run the build' });
  });

  it('reads every chat again, because every reading before this drew no pictures', () => {
    // A chat already read in keeps the transcript the old rules made until the
    // reading it was read by is out of date (bw-khe.11). A floor rather than a
    // number: a later reading that raises it again re-reads these chats too.
    expect(IMPORT_RECIPE).toBeGreaterThanOrEqual(6);
  });
});
