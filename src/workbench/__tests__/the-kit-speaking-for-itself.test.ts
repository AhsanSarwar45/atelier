/**
 * The kit's own sentences, written into a conversation as if the chat had said
 * them, are read as what they are.
 *
 * The manager, 2026-08-21, on "You've hit your session limit · resets 3:50pm
 * (Asia/Karachi)" drawn as an ordinary grey paragraph: "this you hit your
 * session limit, which is the actual status that matters, shows as regular
 * message". Everything sorted by this app arrives as a message ABOUT the run,
 * with a kind on it and a state beside it. These arrive as the run's own
 * answer, so every rule the app has was watching the other door and the one
 * line that means nothing further will happen read like a sentence about code.
 *
 * Four things are held here, and each of them is a way that fails: the stop
 * itself must land in his half of the screen, marked as a stop; the same stop
 * written twice in a row must be one row; a window merely filling up must stay
 * out of his way as the allowance messages already do; and a real answer that
 * happens to open the same way must be left alone, because the price of
 * over-reading is his own words disappearing into a grey chip.
 */
import { describe, expect, it } from 'vitest';

import { drawnRows, familyOf, forWhom, KNOWN_KINDS, KINDS_WITH_AN_AUDIENCE, saidBy } from '@/workbench/machine-lines';
import { KIT_SPEAKS, kitSpoke, SPOKEN_KINDS } from '@/workbench/machine-words';
import { EVERYTHING, QUIET, showing } from '@/workbench/message-filter';
import type { TranscriptItem } from '@/workbench/use-session';

/** Something in the chat's own voice, which is how all of these arrive. */
const said = (text: string, id = text): Extract<TranscriptItem, { kind: 'message' }> => ({
  kind: 'message',
  id: `msg-${id}`,
  role: 'assistant',
  text,
  images: [],
  done: true,
  parentId: null,
});

/** The line he sent, verbatim. */
const STOPPED = "You've hit your session limit · resets 3:50pm (Asia/Karachi)";

/** What is drawn before he touches a switch. */
const readerSees = (items: TranscriptItem[]) => showing(items, QUIET);

describe('the kit talking in the chat’s own voice', () => {
  it('draws the line he sent as the stop it is, in his own half of the screen', () => {
    const rows = drawnRows([said(STOPPED)]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.row).toBe('machine');
    if (row.row !== 'machine') return;
    expect(row.family).toBe('stopped');
    expect(row.audience).toBe('you');
    // Quoted, never rewritten: the time it comes back is the kit's to know.
    expect(saidBy(row)).toBe(STOPPED);
  });

  it('reaches him with nothing switched on, and is not something he has to go and find', () => {
    expect(readerSees([said(STOPPED)])).toHaveLength(1);
    // And it is still the machine's line, so the one switch that hides the
    // machine's own bookkeeping does not take it with it.
    expect(showing([said(STOPPED)], EVERYTHING)).toHaveLength(1);
  });

  it('writes one stop once, however many times the kit says it', () => {
    // One chat in the manager's record says it twice, seconds apart. Two rows
    // read as two separate stops.
    const rows = drawnRows([said(STOPPED, 'a'), said(STOPPED, 'b')]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    if (row.row !== 'machine') throw new Error('the stop was not read as the machine talking');
    expect(row.lines).toHaveLength(2);
  });

  it('keeps a window merely filling up out of his way', () => {
    // The same ruling the allowance messages carry: nothing has stopped, so
    // there is nothing for him to do about it (bw-iiv6.3).
    const filling = said("You've used 80% of your weekly limit");
    expect(readerSees([filling])).toEqual([]);
    expect(showing([filling], EVERYTHING)).toHaveLength(1);
  });

  it('tells him when the work starts costing money, because that is his to stop', () => {
    const rows = drawnRows([said("You're now using usage credits")]);
    const row = rows[0]!;
    if (row.row !== 'machine') throw new Error('the switch to credits was drawn as an answer');
    expect(row.audience).toBe('you');
  });

  it('leaves the chat’s own answer alone, however it opens', () => {
    // The price of reading too much is his own words vanishing into a chip, so
    // the guard is deliberately narrow: one short line, or it is an answer.
    const answer = said("You've used up most of the weekly window, so I stopped\nthe long checks and did the cheap ones first.");
    expect(kitSpoke(answer.text)).toBeNull();
    expect(drawnRows([answer])[0]!.row).toBe('other');

    const essay = said(`You've hit your ${'limit '.repeat(60)}`);
    expect(kitSpoke(essay.text)).toBeNull();
  });

  it('has a family and a reader for every sentence the kit can speak', () => {
    expect(SPOKEN_KINDS.length).toBeGreaterThan(0);
    for (const kind of SPOKEN_KINDS) {
      expect(KNOWN_KINDS).toContain(kind);
      expect(KINDS_WITH_AN_AUDIENCE).toContain(kind);
    }
  });

  it('recognises every opening the table names, and files it under its own kind', () => {
    for (const spoken of KIT_SPEAKS) {
      for (const opening of spoken.opens) {
        expect(kitSpoke(`${opening} — and then some detail`)).toBe(spoken.kind);
      }
      // A stop is a stop whichever way the kit worded it.
      if (spoken.kind === 'kit/limit_reached' || spoken.kind === 'kit/org_blocked') {
        expect(familyOf(spoken.kind, 'note')).toBe('stopped');
        expect(forWhom(spoken.kind, 'note')).toBe('you');
      }
    }
  });
});
