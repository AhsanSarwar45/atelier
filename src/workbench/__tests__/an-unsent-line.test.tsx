/**
 * What he typed and has not sent (bw-33qh).
 *
 * The manager, on the chat screen: "whenever we create a new chat and write
 * text and go to the board or report tab or any other screen, our message in
 * the chat gets erased. similarly if i switch to another chat, the message
 * shows in its chat."
 *
 * Two faults, and they pull in opposite directions, which is why both are
 * pinned here. Leaving the chat tab takes the whole chat screen down, so
 * anything the screen was holding went with it. Switching chats does NOT take
 * it down — which chat is open lives in the address — so one box served every
 * chat and carried his line into the next one.
 *
 * So: it must survive the screen going away, and it must NOT survive the chat
 * changing underneath it. A fix that only does the first is the second fault
 * made worse.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { forgetEveryDraft, rememberUnsentLine, useUnsentLine, useUnsentPictures } from '@/workbench/drafts';
import type { ImagePayload } from '@/workbench/protocol';

const ONE = 'chat-one';
const TWO = 'chat-two';

/** A picture, small enough to read in a failure message. */
const SNAP: ImagePayload = { mime: 'image/png', dataUrl: 'data:image/png;base64,AAA', alt: 'a snap' };

/** The writing box of one chat, opened. */
function box(sessionId: string) {
  return renderHook(() => useUnsentLine(sessionId));
}

beforeEach(() => {
  localStorage.clear();
  forgetEveryDraft();
});

afterEach(() => {
  localStorage.clear();
  forgetEveryDraft();
});

describe('a line he typed and did not send', () => {
  it('can be placed into a newly created chat before its screen mounts', () => {
    rememberUnsentLine(ONE, 'choose a local model, then send this brief');
    expect(box(ONE).result.current[0]).toBe('choose a local model, then send this brief');
  });

  it('is still there when the screen has been taken down and built again', () => {
    const typing = box(ONE);
    act(() => typing.result.current[1]('half a thought'));
    expect(typing.result.current[0]).toBe('half a thought');

    // The trip to the board: this is not a re-render, it is the whole screen
    // going away, which is what `page.tsx` does on every tab switch.
    typing.unmount();

    const back = box(ONE);
    expect(back.result.current[0], 'the line was lost on the way to the board and back').toBe(
      'half a thought',
    );
  });

  it('is not in the next chat he opens', () => {
    const typing = box(ONE);
    act(() => typing.result.current[1]('meant for the first chat'));

    // Switching chats does not take the screen down; the id underneath it
    // changes. That is the shape the fault had.
    act(() => typing.rerender());
    const both = renderHook(({ id }) => useUnsentLine(id), {
      initialProps: { id: ONE },
    });
    expect(both.result.current[0]).toBe('meant for the first chat');
    act(() => both.rerender({ id: TWO }));

    expect(both.result.current[0], 'his line followed him into a chat he never wrote it in').toBe(
      '',
    );
  });

  it('is waiting for him when he comes back to the chat he left it in', () => {
    const both = renderHook(({ id }) => useUnsentLine(id), {
      initialProps: { id: ONE },
    });
    act(() => both.result.current[1]('meant for the first chat'));
    act(() => both.rerender({ id: TWO }));
    act(() => both.result.current[1]('meant for the second'));
    act(() => both.rerender({ id: ONE }));

    expect(both.result.current[0]).toBe('meant for the first chat');
    act(() => both.rerender({ id: TWO }));
    expect(both.result.current[0]).toBe('meant for the second');
  });

  it('survives closing the window, which is what he asked for', () => {
    const typing = box(ONE);
    act(() => typing.result.current[1]('written last night'));
    typing.unmount();

    // A reload: nothing this module was holding survives, and the browser's own
    // store is all there is to read it back out of. Which is why the check
    // below looks in the store itself before it looks at the box.
    expect(Object.values({ ...localStorage })).toContain('written last night');

    const back = box(ONE);
    expect(back.result.current[0], 'the line did not outlive the window').toBe('written last night');
  });

  it('is gone once it has been sent', () => {
    const typing = box(ONE);
    act(() => typing.result.current[1]('off it goes'));
    act(() => typing.result.current[1]('')); // what `submit` does

    typing.unmount();
    expect(box(ONE).result.current[0], 'a sent line came back into the box').toBe('');
  });

  it('comes back into the box when the send is refused', () => {
    // The screen puts the words back rather than into the void (chat-tab.tsx).
    const typing = box(ONE);
    act(() => typing.result.current[1]('this will be refused'));
    act(() => typing.result.current[1](''));
    act(() => typing.result.current[1]('this will be refused'));

    typing.unmount();
    expect(box(ONE).result.current[0]).toBe('this will be refused');
  });
});

describe('pictures he attached and did not send', () => {
  it('are still there when the screen has been taken down and built again', () => {
    const tray = renderHook(() => useUnsentPictures(ONE));
    act(() => tray.result.current[1]((was) => [...was, SNAP]));
    tray.unmount();

    expect(renderHook(() => useUnsentPictures(ONE)).result.current[0]).toEqual([SNAP]);
  });

  it('are not in the next chat he opens', () => {
    const tray = renderHook(({ id }) => useUnsentPictures(id), { initialProps: { id: ONE } });
    act(() => tray.result.current[1]([SNAP]));
    act(() => tray.rerender({ id: TWO }));

    expect(tray.result.current[0]).toEqual([]);
  });

  it('are kept out of the browser’s own store, which they would fill', () => {
    const tray = renderHook(() => useUnsentPictures(ONE));
    act(() => tray.result.current[1]([SNAP]));

    const written = Object.values({ ...localStorage }).join('');
    expect(written, 'a screenshot in the store is how the store starts throwing').not.toContain(
      'data:image/png',
    );
  });
});

describe('what is kept, bounded', () => {
  /** A line typed into one chat and left there, with the screen gone. */
  function left(sessionId: string, words: string) {
    const typing = renderHook(() => useUnsentLine(sessionId));
    act(() => typing.result.current[1](words));
    typing.unmount();
  }

  /** What is in that chat's box when he next opens it. */
  function reopened(sessionId: string): string {
    return renderHook(() => useUnsentLine(sessionId)).result.current[0];
  }

  it('throws the oldest line away once too many are being held', () => {
    left('the-oldest', 'abandoned long ago');
    for (let i = 0; i < 50; i += 1) left(`chat-${i}`, `line ${i}`);

    expect(reopened('the-oldest'), 'nothing was ever thrown away').toBe('');
    expect(reopened('chat-49')).toBe('line 49');
  });

  it('never reaches the line he is typing, however many are held', () => {
    // Writing into a chat moves it to the newest end, so the box in front of
    // him is the last thing the cap could ever take.
    left('the-one-he-is-in', 'still writing this');
    for (let i = 0; i < 49; i += 1) left(`chat-${i}`, `line ${i}`);
    left('the-one-he-is-in', 'still writing this, with more');

    for (let i = 0; i < 5; i += 1) left(`later-${i}`, `later ${i}`);

    expect(reopened('the-one-he-is-in')).toBe('still writing this, with more');
  });

  it('lets go of a chat it is holding nothing for', () => {
    left(ONE, 'typed');
    left(ONE, '');
    for (let i = 0; i < 50; i += 1) left(`chat-${i}`, `line ${i}`);

    // The emptied chat must not still be taking one of the fifty places.
    expect(reopened('chat-0'), 'a sent line went on holding a place in the index').toBe('line 0');
  });

  it('survives an index the browser cannot make sense of', () => {
    localStorage.setItem('workbench.unsent-order', 'not a list at all');
    left(ONE, 'written anyway');

    expect(reopened(ONE)).toBe('written anyway');
  });
});
