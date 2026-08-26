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

import { chatState } from '@/workbench/chat-state';
import { agentRespondedSince } from '@/workbench/chat-tab';
import type { ChatState } from '@/workbench/chat-state';
import type { Brand } from '@/workbench/protocol';
import type { TranscriptItem } from '@/workbench/use-session';
import { WorkingLine } from '@/workbench/transcript-rows';
import { workingLine } from '@/workbench/working-line';

/** A fixed instant, so a count a case asserts is the count it set. */
const NOW = 1_787_138_400_000;

describe.each<Brand>(['claude', 'codex'])('recalling an unanswered %s prompt', (brand) => {
  const before = new Set(['older-answer']);

  it('keeps the prompt recallable when only its user echo has arrived', () => {
    const items: TranscriptItem[] = [
      { kind: 'message', id: 'older-answer', role: 'assistant', text: 'Earlier', images: [], done: true, parentId: null },
      { kind: 'message', id: `${brand}-prompt`, role: 'user', text: 'Let me edit this', images: [], done: true, parentId: null },
    ];

    expect(agentRespondedSince(items, before)).toBe(false);
  });

  it.each([
    ['assistant text', { kind: 'message', id: `${brand}-answer`, role: 'assistant', text: '', images: [], done: false, parentId: null }],
    ['thinking', { kind: 'thinking', id: `${brand}-thinking`, text: '', done: false, parentId: null }],
    ['a tool', { kind: 'tool', id: `${brand}-tool` }],
  ] as const)('stops offering recall after %s begins', (_label, response) => {
    expect(agentRespondedSince([response as TranscriptItem], before)).toBe(true);
  });
});

/** What the chip draws for a chat a terminal holds and is working in. */
const HELD_WORKING: ChatState = {
  word: 'Working',
  working: true,
  waiting: false,
  doing: 'working',
  detail: null,
  told: false,
  mark: 'working',
  since: NOW - 109_000,
  turnSince: null,
  external: { holder: 'terminal' },
};

/** And for the same chat once its terminal has gone quiet. */
const HELD_QUIET: ChatState = {
  word: 'Idle',
  working: false,
  waiting: false,
  doing: 'idle',
  detail: null,
  told: false,
  mark: 'ready',
  since: null,
  turnSince: null,
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
      state: { word: 'Thinking', working: true, waiting: false, doing: 'thinking', detail: null, told: true, mark: 'thinking', since: NOW, turnSince: null, external: null },
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
      state: { word: 'Waiting for you', working: false, waiting: true, doing: 'waiting', detail: null, told: true, mark: 'waiting', since: NOW, turnSince: null, external: null },
      running: null,
    });
    expect(now?.waiting).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The photograph that started this: a Bash card sitting under `Working 1h 38m`
// while the command in it had been going for forty seconds. One clock counted
// the turn and was read as the step, so nothing on the screen could say whether
// anything was stuck (bw-jaoz.14.4).
// ---------------------------------------------------------------------------

describe('a forty-second step inside a turn an hour and a half long', () => {
  it('counts the step beside the word, and the turn quietly behind it', () => {
    // Half a second of slack each way so the count a case asserts survives the
    // milliseconds the render itself takes.
    const now = Date.now();
    const read = chatState({
      state: 'dormant',
      held: {
        id: 'ef56704b',
        holder: 'terminal',
        doing: 'working',
        since: now - 40_500,
        turnSince: now - 5_880_500,
      },
    });
    const line = workingLine({ ...NOTHING_OF_OURS, state: read, running: null });
    render(<div>{line && <WorkingLine {...line} />}</div>);

    expect(screen.getByTestId('working-elapsed').textContent, 'the loud number is this step').toBe('40s');
    expect(screen.getByTestId('working-turn').textContent, 'the whole turn stands behind it').toBe('1h 38m turn');
  });

  it('says the turn once only, when it has anything to add to the step', () => {
    // A turn that IS the step is one number, not the same number twice.
    const now = Date.now();
    const read = chatState({
      state: 'dormant',
      held: { id: 'ef56704b', holder: 'terminal', doing: 'working', since: now - 40_500, turnSince: now - 42_000 },
    });
    const line = workingLine({ ...NOTHING_OF_OURS, state: read, running: null });
    render(<div>{line && <WorkingLine {...line} />}</div>);

    expect(screen.getByTestId('working-elapsed').textContent).toBe('40s');
    expect(screen.queryByTestId('working-turn'), 'a second clock saying the same thing is noise').toBeNull();
  });
});
