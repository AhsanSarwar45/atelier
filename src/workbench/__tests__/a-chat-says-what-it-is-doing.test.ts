import { describe, expect, it } from 'vitest';
import { chatState } from '@/workbench/chat-state';
import { EMPTY, foldAll, reduce } from '@/workbench/fold';
import type { WbpEvent } from '@/workbench/protocol';

/**
 * A chat of ours says which of the things it is doing, and names the call.
 *
 * The driver wrote one `session.state` when the prompt was sent — `streaming`,
 * labelled "Working" — and the next one when the turn ENDED, so a turn that
 * thought, read three files and ran a build drew one word for all of it. The
 * manager, of the ported build: "now it only says 'working'. we ned to fix it
 * so it actually says what the agent is doing" (bw-xfb4).
 *
 * The vocabulary was already here and already drawn by four screens; what was
 * missing was anything feeding it. So these are the two halves of that feed:
 * the word, which the screen owns, and the call, which only the driver knows.
 */

const at = (seq: number) => ({ seq, sessionId: 'chat', at: `2026-09-05T09:00:0${seq}Z` });
const standing = (seq: number, state: string, detail: string | null): WbpEvent =>
  ({ type: 'session.state', state, label: null, detail, ...at(seq) }) as WbpEvent;

describe('a chat of ours says what it is doing', () => {
  it('names the command in flight, and gives it up when the call is over', () => {
    const told = [
      standing(1, 'thinking', null),
      standing(2, 'running_tool', 'cargo test --lib'),
      standing(3, 'streaming', null),
    ];

    // A reload and a live tail draw the same chat, so both are asked.
    const reloaded = foldAll(told);
    const tailed = told.reduce(reduce, EMPTY);
    for (const view of [reloaded, tailed]) {
      expect(view.state).toBe('streaming');
      expect(view.stateDetail).toBeNull();
    }
    expect(foldAll(told.slice(0, 2)).stateDetail).toBe('cargo test --lib');
  });

  it('draws the screen’s own word beside the driver’s call', () => {
    const running = foldAll([standing(1, 'running_tool', 'cargo test --lib')]);
    const read = chatState({ state: running.state, label: running.stateLabel, detail: running.stateDetail });
    // The word is the screen's, which is why the driver publishes none: four
    // screens share this one and a word invented at the boundary would be a
    // fifth opinion. It also used to be "Working" here while a chat somebody
    // else held, doing exactly the same thing, said "Running".
    expect(read.word).toBe('Running');
    expect(read.detail).toBe('cargo test --lib');
    expect(read.working).toBe(true);
  });

  it('lets a driver that does name its own standing keep the word', () => {
    // Nothing about this is taken away: a permission wait is published with its
    // own sentence and still draws it.
    const asked = foldAll([
      { type: 'session.state', state: 'waiting_permission', label: 'Waiting for your answer', ...at(1) } as WbpEvent,
    ]);
    expect(chatState({ state: asked.state, label: asked.stateLabel, detail: asked.stateDetail }).word).toBe(
      'Waiting for your answer',
    );
  });
});
