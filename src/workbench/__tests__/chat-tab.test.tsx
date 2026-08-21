/**
 * The line at the foot of a chat somebody else is working in (bw-jaoz.3).
 *
 * The manager, with a photograph of his terminal beside our screen: the
 * terminal said `Computing… 1m 49s` and the chat body said nothing at all. The
 * line under the last message asked one question — is a driver of OURS busy —
 * and a chat a terminal holds has no driver of ours, so the foot of it stayed
 * blank through the whole turn while the chip an inch above it said Working.
 *
 * Two halves are pinned here: the decision (`workingLine`), and the line the
 * decision draws, because "present" and "absent" are facts about the screen and
 * not about a return value.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ChatState } from '@/workbench/chat-state';
import { WorkingLine } from '@/workbench/transcript-rows';
import { workingLine } from '@/workbench/working-line';

/** A fixed instant, so a count a case asserts is the count it set. */
const NOW = 1_787_138_400_000;

/** What the chip draws for a chat a terminal holds and is working in. */
const HELD_WORKING: ChatState = {
  word: 'Working',
  working: true,
  waiting: false,
  since: NOW - 109_000,
  external: { holder: 'terminal' },
};

/** And for the same chat once its terminal has gone quiet. */
const HELD_QUIET: ChatState = {
  word: 'Idle',
  working: false,
  waiting: false,
  since: null,
  external: { holder: 'terminal' },
};

/** No driver of ours on it at all, which is every held chat. */
const NOTHING_OF_OURS = { busy: false, label: 'Ready', since: null, waiting: false, thought: 0 };

/** The foot of the conversation, drawn from that reading — or nothing. */
function foot(state: ChatState, running: { title: string; seconds: number } | null = null) {
  const now = workingLine({ ...NOTHING_OF_OURS, state, running });
  render(<div>{now && <WorkingLine {...now} />}</div>);
  return screen.queryByTestId('working-line');
}

describe('a chat somebody else is working in', () => {
  it('draws the working line, from the holder’s own reading', () => {
    const line = foot(HELD_WORKING);
    expect(line, 'the body of a held chat is blank again while its terminal works').not.toBeNull();
    expect(line?.textContent).toContain('Working');
  });

  it('names the command they are running, the way their terminal names it', () => {
    const line = foot(HELD_WORKING, { title: 'npm test', seconds: 109 });
    expect(line?.textContent).toContain('npm test');
    // Their count, not ours: the row was drawn when we noticed it, and the
    // reader wants the number their terminal is showing.
    expect(line?.getAttribute('data-seconds')).toBe('109');
  });

  it('draws nothing once the holder goes quiet', () => {
    expect(foot(HELD_QUIET), 'a chat nobody is working in claims a turn in flight').toBeNull();
  });

  it('never asks the reader for anything on somebody else’s behalf', () => {
    // `waiting` is the screen asking THIS reader to answer. A held chat asks
    // its holder, in their own window.
    const line = foot(HELD_WORKING);
    expect(line?.getAttribute('data-waiting')).toBe('false');
  });
});

describe('a chat a driver of ours is working in', () => {
  it('keeps its own driver’s words, which name the state every second', () => {
    const now = workingLine({
      busy: true,
      label: 'Thinking',
      since: NOW - 4_000,
      waiting: false,
      thought: 1_200,
      state: { word: 'Thinking', working: true, waiting: false, since: NOW, external: null },
      running: null,
    });
    expect(now?.label).toBe('Thinking');
    expect(now?.since).toBe(NOW - 4_000);
    expect(now?.thought).toBe(1_200);
  });

  it('and its own waiting mark, which is the one state that is asking him', () => {
    const now = workingLine({
      busy: true,
      label: 'Run the tests',
      since: NOW,
      waiting: true,
      thought: 0,
      state: { word: 'Waiting for you', working: false, waiting: true, since: NOW, external: null },
      running: null,
    });
    expect(now?.waiting).toBe(true);
  });
});
