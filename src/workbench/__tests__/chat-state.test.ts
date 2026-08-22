/**
 * The one reading every screen draws a chat from.
 *
 * Four screens used to answer "what is this chat doing" four ways, and the
 * loudest of them said "working" over a terminal sitting at an empty prompt.
 * These cases hold the reading to the three facts it separates: what it is
 * doing this second, where it stands when it is doing nothing, and who holds
 * it — the last of which never stands in place of the first two (bw-96is).
 */
import { describe, expect, it } from 'vitest';

import {
  DOING_COUNTS,
  DOING_MARK,
  DOING_WORD,
  HOLDER_WORD,
  RECORD_QUIET_MS,
  answerOwed,
  chatState,
  counting,
  heldDoing,
  heldLine,
  holderOnly,
  isWorking,
  whatItIsDoing,
  type Doing,
  type HeldChat,
} from '@/workbench/chat-state';
import type { SessionState } from '@/workbench/protocol';

/** Every state a chat of ours can be published in, in the protocol's own order. */
const ALL: SessionState[] = [
  'starting',
  'idle',
  'thinking',
  'streaming',
  'running_tool',
  'waiting_permission',
  'stopped',
  'errored',
  'ended',
  'dormant',
];

/** The states in which an agent of ours owes an answer and the mark must move. */
const MOVING: SessionState[] = ['starting', 'thinking', 'streaming', 'running_tool'];

function held(over: Partial<HeldChat> = {}): HeldChat {
  return { id: 'ef56704b', holder: 'terminal', doing: 'working', since: 1_000, ...over };
}

describe('a chat of ours', () => {
  it('moves the mark in exactly the states where an answer is owed', () => {
    for (const state of ALL) {
      expect(chatState({ state }).working, `${state} drew the wrong mark`).toBe(MOVING.includes(state));
    }
  });

  it('says something in every state, and never says two things at once', () => {
    for (const state of ALL) {
      const read = chatState({ state });
      expect(read.word, `${state} said nothing at all`).not.toBe('');
      // Working and waiting are two different marks; a chat is one or neither.
      expect(read.working && read.waiting, `${state} drew both marks`).toBe(false);
      expect(read.external, `${state} claimed a holder with none given`).toBeNull();
    }
  });

  it('counts seconds while something is going on, and not once it has stopped', () => {
    for (const state of ALL) {
      const read = chatState({ state, since: 5_000 });
      const shouldCount = MOVING.includes(state) || state === 'waiting_permission';
      expect(read.since, `${state} counted the wrong way`).toBe(shouldCount ? 5_000 : null);
      expect(counting(state), `counting() disagreed about ${state}`).toBe(shouldCount);
    }
  });

  it('prefers the driver’s own words to the table behind them', () => {
    expect(chatState({ state: 'running_tool', label: 'Asking about Edit' }).word).toBe('Asking about Edit');
    // The floor, for a label a dead process left behind or never wrote.
    expect(chatState({ state: 'running_tool', label: '' }).word).toBe('Working');
    expect(chatState({ state: 'dormant', label: null }).word).toBe('Asleep');
  });

  it('waiting on the reader is its own mark, not working', () => {
    const read = chatState({ state: 'waiting_permission', since: 9 });
    expect([read.working, read.waiting, read.since]).toEqual([false, true, 9]);
  });
});

describe('a chat another program holds', () => {
  it('says what the holder is doing, whatever our own side was left saying', () => {
    // Our state for a held chat is dormant — no agent of ours is attached —
    // and drawing "Asleep" over a terminal mid-turn is the exact lie this
    // replaces.
    for (const state of ALL) {
      const read = chatState({ state, label: 'Answering', held: held() });
      expect(read.working, `${state} lost the holder's word`).toBe(true);
      expect(read.word).toBe('Working');
      expect(read.since).toBe(1_000);
    }
  });

  it('draws the badge in every state, and never in place of the doing', () => {
    for (const state of ALL) {
      for (const doing of ['working', 'idle', 'unknown'] as const) {
        const read = chatState({ state, held: held({ doing }) });
        expect(read.external, `${state}/${doing} lost the badge`).toEqual({ holder: 'terminal' });
      }
    }
  });

  it('is idle when the holder says so, with nothing counting', () => {
    const read = chatState({ state: 'dormant', held: held({ doing: 'idle', since: 5 }) });
    expect([read.working, read.word, read.since]).toEqual([false, 'Idle', null]);
  });

  it('claims nothing at all when nothing on the machine will say', () => {
    const read = chatState({ state: 'dormant', held: held({ doing: 'unknown', since: null }) });
    // No word means the chip draws nothing; the badge beside it is the whole
    // of what the screen can honestly say.
    expect([read.working, read.waiting, read.word]).toEqual([false, false, '']);
    expect(read.external).toEqual({ holder: 'terminal' });
  });

  it('keeps the holder and drops the doing when the stream that kept it current is gone', () => {
    // The screens hold this answer for as long as nobody is speaking, which is
    // up to half a minute of retrying, and a mark drawn from it goes on turning
    // and counting all the while — identical on screen to a chat somebody is
    // really working in (bw-96is.22).
    const read = chatState({ state: 'dormant', held: holderOnly(held({ doing: 'working', since: 1_000 })) });
    expect(read.external, 'the badge went with it, and who is in there had not changed').toEqual({ holder: 'terminal' });
    expect([read.working, read.word, read.since], 'a dead fact was still being drawn as work').toEqual([
      false,
      '',
      null,
    ]);
  });

  it('has nothing to forget about a chat nobody holds', () => {
    expect(holderOnly(null)).toBeNull();
    expect(holderOnly(undefined)).toBeNull();
  });

  it('never mistakes one kind of holder for the other', () => {
    expect(chatState({ state: 'dormant', held: held({ holder: 'program' }) }).external).toEqual({
      holder: 'program',
    });
  });
});

describe('what a held chat is doing, from the two signals there are', () => {
  const now = 1_787_138_400_000;

  it('takes the holder’s own word first, and the moment it said it', () => {
    expect(heldDoing({ status: 'busy', statusAt: now - 4_000, recordMovedAt: null, owed: null, burstAt: null, now })).toEqual({
      doing: 'working',
      since: now - 4_000,
      // A busy bit says busy and nothing about steps, so there is no second
      // number to draw beside it.
      turnSince: null,
    });
    // Its word beats the record even when the record disagrees: a chat that
    // has just been told to stop is idle the moment it says so, however
    // recently it was writing.
    expect(heldDoing({ status: 'idle', statusAt: now, recordMovedAt: now, owed: null, burstAt: null, now })).toEqual({
      doing: 'idle',
      since: null,
      turnSince: null,
    });
  });

  it('falls back to the record moving when nothing says a word', () => {
    const moving = heldDoing({ status: null, statusAt: null, recordMovedAt: now - 2_000, owed: null, burstAt: null, now });
    expect(moving).toEqual({ doing: 'working', since: now - 2_000, turnSince: null });

    const quiet = heldDoing({
      status: null,
      statusAt: null,
      recordMovedAt: now - RECORD_QUIET_MS - 1,
      owed: null,
      burstAt: null,
      now,
    });
    expect(quiet).toEqual({ doing: 'idle', since: null, turnSince: null });
  });

  it('counts the step from the last line written and the turn from where it began', () => {
    // Two numbers, because they answer two questions. The record's newest write
    // is where the step the reader is watching started; the burst's own start is
    // how long the whole answer has run. One clock reported the second and was
    // read as the first (bw-jaoz.14.4).
    const begun = now - 30_000;
    expect(
      heldDoing({ status: null, statusAt: null, recordMovedAt: now - 1_000, owed: null, burstAt: begun, now }),
    ).toEqual({ doing: 'working', since: now - 1_000, turnSince: begun });
  });

  it('says it does not know rather than guessing idle', () => {
    // A host-driven process writes no status; if its record is not found
    // either, the honest answer is nothing at all — not that it is idle.
    expect(heldDoing({ status: null, statusAt: null, recordMovedAt: null, owed: null, burstAt: null, now })).toEqual({
      doing: 'unknown',
      since: null,
      turnSince: null,
    });
  });

  it('stays working through a long think, which writes nothing at all', () => {
    // The manager's own words: "the working chip only shows when its running
    // some commands or soemthing". A think writes nothing for a minute or two,
    // so the ten-second rule below called it idle and the mark went out — and
    // came back the instant a command finished (bw-jaoz.4).
    const thinking = heldDoing({
      status: null,
      statusAt: null,
      recordMovedAt: now - 100_000,
      owed: true,
      burstAt: now - 100_000,
      now,
    });
    expect(thinking).toEqual({ doing: 'working', since: now - 100_000, turnSince: now - 100_000 });
  });

  it('and the holder’s own word still beats it, either way', () => {
    // A chat told to stop mid-command owes an answer that is never coming.
    expect(
      heldDoing({ status: 'idle', statusAt: now, recordMovedAt: now, owed: true, burstAt: null, now }),
    ).toEqual({ doing: 'idle', since: null, turnSince: null });
  });

  it('is silent about when a chat went idle, so nothing counts against it', () => {
    for (const status of ['idle', null]) {
      const read = heldDoing({ status, statusAt: now, recordMovedAt: now - RECORD_QUIET_MS - 1, owed: null, burstAt: now, now });
      expect(read.since, `${status ?? 'no'} status left a count running`).toBeNull();
    }
  });
});

describe('what the end of a record says about the turn', () => {
  const call = { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} };

  it('owes an answer after anything the person said', () => {
    expect(answerOwed({ type: 'user', message: { role: 'user', content: 'run the tests' } })).toBe(true);
  });

  it('owes one after a command’s output comes back, which is written as his line', () => {
    expect(
      answerOwed({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '282 passed' }] },
      }),
    ).toBe(true);
  });

  it('owes one after the agent asks for a tool', () => {
    expect(answerOwed({ type: 'assistant', message: { role: 'assistant', content: [call] } })).toBe(true);
  });

  it('owes nothing once the agent has said its piece: that is the turn over', () => {
    expect(
      answerOwed({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }),
    ).toBe(false);
  });

  it('says nothing rather than idle when there was nothing to read', () => {
    expect(answerOwed(null)).toBe(false);
  });
});

describe('the line where a held chat’s writing box would be', () => {
  /** The reading for a held chat, as the pane has it. */
  const held = (doing: HeldChat['doing'], holder: HeldChat['holder'] = 'terminal') =>
    chatState({ state: 'dormant', held: { id: 'c', holder, doing, since: 1_000 } });

  it('claims somebody is working only while the mark beside it says so', () => {
    // The two are a foot apart on the screen. The line used to say somebody was
    // working in the chat whatever the holder was doing, so a terminal that had
    // gone quiet drew "Idle" and a flat contradiction of it (bw-96is.9).
    expect(heldLine(held('working'))).toContain('is working in it now');
    for (const doing of ['idle', 'unknown'] as const) {
      expect(heldLine(held(doing)), `${doing} was described as working`).not.toContain('working');
    }
  });

  it('says they have it open whatever they are doing, because that is what is true', () => {
    for (const doing of ['working', 'idle', 'unknown'] as const) {
      expect(heldLine(held(doing)), `${doing} said nothing about who holds it`).toContain('has this chat open');
    }
  });

  it('names a terminal as somebody and anything else as another program', () => {
    expect(heldLine(held('idle', 'terminal'))).toContain('in a terminal');
    expect(heldLine(held('idle', 'program'))).toContain('Another program');
    expect(heldLine(held('idle', 'program'))).not.toContain('terminal');
  });

  it('promises the box back when they let go, not when they stop working', () => {
    // A terminal that has stopped working still holds the conversation, so
    // "when they stop" promised a box that does not arrive.
    const line = heldLine(held('idle'));
    expect(line).toContain('comes back when they let go');
    expect(line).not.toContain('when they stop');
  });

  it('opens with the same sentence the badge’s tooltip is built from', () => {
    // Three screens say who has the chat — this line, the badge on a row, and
    // the sidecar's refusal when he types into one anyway — and all three read
    // it from here. Typed out separately they had already drifted: two said the
    // holder "has this chat open" and the third said it was "working in" it
    // (bw-96is.13).
    for (const holder of ['terminal', 'program'] as const) {
      expect(heldLine(held('idle', holder)).startsWith(HOLDER_WORD[holder])).toBe(true);
    }
  });

  it('the shared sentence says who has it and nothing about work', () => {
    for (const [holder, word] of Object.entries(HOLDER_WORD)) {
      expect(word, `${holder} claims activity`).not.toContain('working');
      // The callers punctuate: this line continues the sentence, the tooltip
      // ends it.
      expect(word.endsWith('.'), `${holder} punctuates for its callers`).toBe(false);
    }
  });
});

describe('the whole vocabulary for what a chat is doing', () => {
  /**
   * Every word the reading can draw, and what each one is owed.
   *
   * Written out here rather than read off the tables under test, so a table
   * edited by hand cannot quietly agree with itself. The manager's screenshot,
   * 2026-08-22, is why there is more than one row: a two-minute summarising run
   * drawn as `Working 1h 38m`, which is what a reading with a single
   * busy-or-not signal has to say about every one of these.
   */
  const VOCABULARY: {
    doing: Doing;
    word: string;
    mark: string;
    /** Whether seconds are drawn beside the word. */
    counts: boolean;
    /** Whether it means the chat owes an answer — the primary, moving mark. */
    working: boolean;
  }[] = [
    { doing: 'thinking', word: 'Thinking', mark: 'thinking', counts: true, working: true },
    { doing: 'answering', word: 'Answering', mark: 'answering', counts: true, working: true },
    { doing: 'running', word: 'Running', mark: 'running', counts: true, working: true },
    { doing: 'summarising', word: 'Summarising', mark: 'summarising', counts: true, working: true },
    { doing: 'retrying', word: 'Retrying', mark: 'retrying', counts: true, working: true },
    { doing: 'helping', word: 'Helper working', mark: 'helping', counts: true, working: true },
    { doing: 'working', word: 'Working', mark: 'working', counts: true, working: true },
    // Not working: it is the chat asking rather than answering, and the whole
    // point of its own mark is that the two do not look alike.
    { doing: 'waiting', word: 'Waiting for you', mark: 'waiting', counts: true, working: false },
    { doing: 'idle', word: 'Idle', mark: 'ready', counts: false, working: false },
    // The reading declining to claim anything. A badge beside it may still say
    // who holds the chat; the chip itself draws nothing.
    { doing: 'unknown', word: '', mark: 'ready', counts: false, working: false },
  ];

  it('gives each one its own word, its own mark and its own clock rule', () => {
    for (const { doing, word, mark, counts, working } of VOCABULARY) {
      expect(DOING_WORD[doing], `${doing} drew the wrong word`).toBe(word);
      expect(DOING_MARK[doing], `${doing} drew the wrong mark`).toBe(mark);
      expect(DOING_COUNTS[doing], `${doing} counted the wrong way`).toBe(counts);
      expect(isWorking(doing), `${doing} was owed the wrong mark`).toBe(working);
    }
  });

  it('covers every word the type allows, so a new one cannot be added unread', () => {
    expect(VOCABULARY.map((v) => v.doing).sort()).toEqual(Object.keys(DOING_WORD).sort());
  });

  it('says a different thing for each: no two states read alike', () => {
    // The fault this replaces, stated as a rule. Five of these drew the same
    // word, so the screen could not tell a chat mid-thought from one stopped
    // dead on a permission prompt.
    const said = VOCABULARY.filter((v) => v.doing !== 'unknown').map((v) => `${v.word}/${v.mark}`);
    expect(new Set(said).size).toBe(said.length);
  });

  it('draws it whole for a held chat, whatever our own side was left saying', () => {
    for (const { doing, word, mark, counts, working } of VOCABULARY) {
      const read = chatState({ state: 'dormant', held: held({ doing, since: 1_000 }) });
      expect(read.doing, `${doing} was lost on the way through`).toBe(doing);
      expect([read.word, read.mark], `${doing} drew the wrong chip`).toEqual([word, mark]);
      expect(read.since, `${doing} counted the wrong way`).toBe(counts ? 1_000 : null);
      expect(read.working, `${doing} was owed the wrong mark`).toBe(working);
      // Never in place of the doing, in any state.
      expect(read.external, `${doing} lost the badge`).toEqual({ holder: 'terminal' });
    }
  });

  it('draws the waiting mark on a held chat stopped on a prompt, not a grey one', () => {
    // It asks its holder rather than this reader, which settles who answers it
    // and nothing about what the screen owes: the reader is looking at a chat
    // that has stopped and is waiting on a person (bw-jaoz.14.3).
    const read = chatState({ state: 'dormant', held: held({ doing: 'waiting', since: 1_000 }) });
    expect([read.working, read.waiting, read.since]).toEqual([false, true, 1_000]);
  });

  it('gives our own driver’s states the same vocabulary, not a second one', () => {
    const ours: [SessionState, Doing][] = [
      ['thinking', 'thinking'],
      ['streaming', 'answering'],
      ['running_tool', 'running'],
      ['waiting_permission', 'waiting'],
      // Plainly busy, and nothing yet says at what. The honest word, not a guess.
      ['starting', 'working'],
    ];
    for (const [state, doing] of ours) {
      const read = chatState({ state, since: 5_000 });
      expect(read.doing, `${state} read as the wrong thing`).toBe(doing);
      expect(read.mark, `${state} drew a mark of its own`).toBe(DOING_MARK[doing]);
      expect(read.since, `${state} counted the wrong way`).toBe(DOING_COUNTS[doing] ? 5_000 : null);
    }
  });

  it('every state of ours that is at rest reads as idle, and counts nothing', () => {
    for (const state of ['idle', 'stopped', 'errored', 'ended', 'dormant'] as const) {
      const read = chatState({ state, since: 5_000 });
      expect(read.doing, `${state} claimed to be doing something`).toBe('idle');
      expect(read.since, `${state} left a clock running`).toBeNull();
    }
  });

  it('says our own driver told us, and a record we read did not', () => {
    // What the difference is for: a word we were told can be trusted to be
    // specific, and one we worked out is only as good as the tail of a file.
    expect(chatState({ state: 'thinking' }).told).toBe(true);
    expect(chatState({ state: 'dormant', held: held({ doing: 'working' }) }).told).toBe(false);
    expect(chatState({ state: 'dormant', held: held({ doing: 'summarising', told: true }) }).told).toBe(true);
  });

  it('carries the holder’s own words through, and nothing where there are none', () => {
    expect(chatState({ state: 'dormant', held: held({ detail: 'npm test' }) }).detail).toBe('npm test');
    expect(chatState({ state: 'dormant', held: held() }).detail).toBeNull();
    expect(chatState({ state: 'running_tool', detail: 'Asking about Edit' }).detail).toBe('Asking about Edit');
    expect(chatState({ state: 'running_tool' }).detail).toBeNull();
  });

  it('forgets what a dropped chat was doing, and that it was ever told it', () => {
    const stale = holderOnly(held({ doing: 'summarising', since: 1_000, detail: 'freeing up room', told: true }));
    expect(stale).toEqual({ ...held(), doing: 'unknown', since: null, turnSince: null, detail: null, told: false });
  });
});

describe('the order the two signals are combined in', () => {
  const now = 1_787_138_400_000;

  it('takes what the session said about itself over what we read off its record', () => {
    // The one-sided failure this prevents: a summarising chat is silent for two
    // minutes, so the record reads it as a chat somebody walked away from —
    // confidently, and wrongly, exactly when the screen matters most.
    expect(
      whatItIsDoing({
        told: { doing: 'summarising', since: now - 40_000 },
        read: { doing: 'idle', since: null },
      }),
    ).toEqual({ doing: 'summarising', since: now - 40_000, detail: null, told: true });
  });

  it('never lets a guess override a told state, however sure the guess looks', () => {
    for (const guess of Object.keys(DOING_WORD) as Doing[]) {
      const both = whatItIsDoing({
        told: { doing: 'waiting', since: now - 9_000, detail: 'Edit' },
        read: { doing: guess, since: now },
      });
      expect(both, `a read '${guess}' beat what the session said`).toEqual({
        doing: 'waiting',
        since: now - 9_000,
        detail: 'Edit',
        told: true,
      });
    }
  });

  it('falls to the record only where nothing was told, and says which it was', () => {
    expect(whatItIsDoing({ told: null, read: { doing: 'running', since: now } })).toEqual({
      doing: 'running',
      since: now,
      detail: null,
      told: false,
    });
  });

  it('treats “I do not know” as declining to say, not as an answer', () => {
    // Either side may decline. An unwired session tells us nothing while its
    // record still shows it writing; a chat whose record we cannot find is
    // still worth drawing from what it published.
    expect(whatItIsDoing({ told: { doing: 'unknown', since: null }, read: { doing: 'running', since: now } })).toEqual({
      doing: 'running',
      since: now,
      detail: null,
      told: false,
    });
    expect(whatItIsDoing({ told: { doing: 'thinking', since: now }, read: null })).toEqual({
      doing: 'thinking',
      since: now,
      detail: null,
      told: true,
    });
  });

  it('claims nothing at all when neither signal will say', () => {
    expect(whatItIsDoing({ told: null, read: null })).toEqual({
      doing: 'unknown',
      since: null,
      detail: null,
      told: false,
    });
  });

  it('drops a clock the state has no business counting, whichever side sent it', () => {
    // A holder reporting `idle` with the moment it went idle is not offering a
    // clock; drawn beside "Idle" it claims something is going on.
    expect(whatItIsDoing({ told: { doing: 'idle', since: now }, read: null }).since).toBeNull();
    expect(whatItIsDoing({ told: null, read: { doing: 'idle', since: now } }).since).toBeNull();
  });
});
