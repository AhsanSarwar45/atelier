/**
 * Every machine line is a sentence, and it is filed by what that sentence means.
 *
 * The manager's screenshot of 2026-08-21 held one line: "Allowance: the
 * seven-day window is allowed_warning until 12:00 PM", drawn in his own group.
 * Two faults in one row. The sentence was built by pasting the wire's word into
 * English prose, and the filing was guessed from how loud the line was — and
 * loudness cannot tell a window filling up from a window that has stopped his
 * work, so both landed in front of him.
 *
 * So the words and the reader are settled together, once, in a table read off
 * the kit's own types (machine-words.ts), the driver carries the answer on the
 * note, and the lines already written are restated on the way to the screen.
 * This holds all three. What it cannot see — a kind the kit declares that the
 * table has never heard of — is the screen check's job
 * (scripts/chat-shows-what-is-yours.mjs), which reads the kit's types and his
 * real record.
 */
import { describe, expect, it } from 'vitest';

import { drawnRows } from '@/workbench/machine-lines';
import { inWords, KINDS_WITH_STATES, PERMISSION_MODE, saidOf, WORDS, whoFor } from '@/workbench/machine-words';
import type { Audience, NoteRank } from '@/workbench/protocol';
import type { TranscriptItem } from '@/workbench/use-session';

/** A word shaped like an identifier: an underscore inside it, or a capital. */
const OFF_THE_WIRE = /\b[a-z]+(?:_[a-z]+)+\b|\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z]+[A-Z]\w*\b/;

/** One note as the reducer stores it, with or without the driver's ruling on it. */
const note = (
  kind: string,
  text: string,
  rank: NoteRank = 'note',
  audience?: Audience,
): TranscriptItem => ({
  kind: 'note',
  id: `note-${kind}-${text}`,
  rank,
  noteKind: kind,
  text,
  body: null,
  ...(audience ? { audience } : {}),
});

/** What one item is drawn as, or nothing if it is not a machine line at all. */
const drawn = (item: TranscriptItem) => {
  const row = drawnRows([item])[0];
  return row.row === 'machine' ? row : null;
};

describe('what a machine line says', () => {
  it('writes every state the table names without using the wire\'s own word', () => {
    const wired: string[] = [];
    for (const kind of KINDS_WITH_STATES) {
      for (const [state, word] of Object.entries(WORDS[kind].states)) {
        if (word.said === null) continue; // The message carries its own wording.
        if (OFF_THE_WIRE.test(word.said)) wired.push(`${kind}.${state}: ${word.said}`);
      }
    }
    expect(wired).toEqual([]);
  });

  it('names a reader for every state, and tells a full window from a closed one', () => {
    for (const kind of KINDS_WITH_STATES) {
      for (const state of Object.keys(WORDS[kind].states)) {
        expect(whoFor(kind, state), `${kind}.${state}`).not.toBeNull();
      }
    }
    // The row from his screenshot. Nothing to do while it merely fills up;
    // everything to do once it has actually turned work away.
    expect(whoFor('rate_limit_event', 'allowed')).toBe('machine');
    expect(whoFor('rate_limit_event', 'allowed_warning')).toBe('machine');
    expect(whoFor('rate_limit_event', 'rejected')).toBe('you');
    expect(whoFor('rate_limit_event', 'credits_required')).toBe('you');
  });

  it('says nothing about a state nobody has ruled on, rather than guessing', () => {
    expect(saidOf('rate_limit_event', 'invented_by_the_kit')).toBeNull();
    expect(whoFor('rate_limit_event', 'invented_by_the_kit')).toBeNull();
  });

  it('opens a wire word up when it has never met one, instead of printing it raw', () => {
    expect(inWords('bypassPermissions')).toBe('Bypass permissions');
    expect(inWords('error_max_turns')).toBe('Error max turns');
  });
});

describe('who the line is drawn for', () => {
  it('takes the driver\'s ruling over anything the screen would have guessed', () => {
    // Loudness would have made this his; the state says otherwise, and the
    // state is what the driver put on the note.
    expect(drawn(note('rate_limit_event', 'Your weekly allowance is running low.', 'note', 'machine'))?.audience).toBe('machine');
    expect(drawn(note('rate_limit_event', 'Your weekly allowance has run out.', 'note', 'you'))?.audience).toBe('you');
  });

  it('reads an older allowance line off its own frozen wording', () => {
    // Written before the driver ruled, and never rewritten in the record
    // (bw-x6hb). Only one of these turned his work away.
    expect(drawn(note('rate_limit_event', 'Allowance: the seven-day window is allowed_warning until 12:00 PM'))?.audience).toBe('machine');
    expect(drawn(note('rate_limit_event', 'Allowance: the five-hour window is rejected until 03:20 AM'))?.audience).toBe('you');
  });
});

describe('lines already in the record', () => {
  it('says an old allowance line again in English', () => {
    expect(drawn(note('rate_limit_event', 'Allowance: the seven-day window is allowed_warning until 12:00 PM'))?.lines[0].text)
      .toBe('Your weekly allowance is running low (it renews at 12:00 PM).');
    expect(drawn(note('rate_limit_event', 'Allowance: the five-hour window is open until 12:10 AM'))?.lines[0].text)
      .toBe('Your five-hour allowance is fine (it renews at 12:10 AM).');
  });

  it('says the one line he MUST read in English, however it was written', () => {
    // Thirty-seven of these are in his record, every one drawn to him, every
    // one announcing that a chat has stopped asking before it runs things.
    expect(drawn(note('mode', 'Permission mode is now bypassPermissions.'))?.lines[0].text)
      .toBe(`This chat will now ${PERMISSION_MODE.bypassPermissions.said}.`);
    expect(drawn(note('mode', 'Permission mode is now acceptEdits.'))?.lines[0].text)
      .toBe('This chat will now change files without asking.');
    // A mode this build has never met still arrives readable.
    expect(drawn(note('mode', 'Permission mode is now someNewMode.'))?.lines[0].text)
      .toBe('This chat will now some new mode.');
  });

  it('replaces a line that was never a sentence at all', () => {
    // The driver used to fall back to printing the kind itself.
    expect(drawn(note('rate_limit_event', 'rate_limit_event'))?.lines[0].text).toBe('Your usage allowance changed.');
    expect(drawn(note('system/task_updated', 'system/task_updated'))?.lines[0].text)
      .toBe('Something changed about an agent you sent off.');
  });

  it('leaves a sentence it does not recognise exactly as it was written', () => {
    const said = 'Allowance restored by hand at 04:00.';
    expect(drawn(note('rate_limit_event', said))?.lines[0].text).toBe(said);
  });
});
