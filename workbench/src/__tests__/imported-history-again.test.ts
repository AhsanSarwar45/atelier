/**
 * @vitest-environment node
 *
 * A chat read in under an older rule is read in again.
 *
 * The rules for reading a record back change — the words alone became the words
 * and the commands, then the change each edit made, then how full the
 * conversation stands. A chat read in before one of those changes keeps the
 * transcript the old rules made, harness lines and all, and the reader has no
 * way to ask for the new one short of deleting the chat. So the reading carries
 * a number, and a chat marked with a lower one is read again on its next open
 * (bw-khe.11).
 *
 * The exception is the whole difficulty: a chat that was also SPOKEN TO here
 * holds turns that exist in no record. Reading its record again would throw
 * away the only copy of those, so that one keeps what it has (bw-1u1.26).
 */
import { describe, expect, it } from 'vitest';

import {
  howToRead,
  IMPORT_RECIPE,
  saidByAnyone,
  type ReadSoFarState,
} from '../../../src/workbench/imported-history.ts';

/** What is known about a chat before its record is opened, with the quiet defaults. */
function chat(was: Partial<ReadSoFarState> = {}): ReadSoFarState {
  return {
    readBy: null,
    live: false,
    drawn: () => 0,
    drivenHere: () => false,
    ...was,
  };
}

describe('opening a chat that may have been read before', () => {
  it('reads one nothing has ever read', () => {
    expect(howToRead(chat())).toBe('read-it');
  });

  it('leaves one this very reading already read', () => {
    expect(howToRead(chat({ readBy: IMPORT_RECIPE }))).toBe('leave-it');
  });

  it('reads one an older reading read, however many rows it has', () => {
    expect(howToRead(chat({ readBy: IMPORT_RECIPE - 1, drawn: () => 400 }))).toBe('read-it');
  });

  it('reads a Codex chat again after the reply-message recipe changed', () => {
    expect(howToRead(chat({ readBy: 8, drawn: () => 1, drivenHere: () => false }))).toBe('read-it');
  });

  it('reads one read by the very first reading there was', () => {
    expect(howToRead(chat({ readBy: 1 }))).toBe('read-it');
  });

  it('keeps what a chat holds when it was also spoken to here', () => {
    // Those turns are in no record; re-reading would be the only copy gone.
    expect(howToRead(chat({ readBy: IMPORT_RECIPE - 1, drivenHere: () => true }))).toBe(
      'keep-what-it-has',
    );
  });

  it('keeps what a chat holds when it was spoken to here and never read at all', () => {
    expect(howToRead(chat({ readBy: null, drawn: () => 12, drivenHere: () => true }))).toBe(
      'keep-what-it-has',
    );
  });

  it('reads one that was spoken to here but has nothing to lose', () => {
    expect(howToRead(chat({ readBy: null, drawn: () => 0, drivenHere: () => true }))).toBe('read-it');
  });

  it('reads for the follower even when this reading already read it', () => {
    // The follower is not re-reading the past; it is carrying on past the mark.
    expect(howToRead(chat({ readBy: IMPORT_RECIPE, live: true }))).toBe('read-it');
  });
});

describe('what deciding costs', () => {
  it('asks the log nothing about a chat this reading already read', () => {
    let asked = 0;
    howToRead(
      chat({
        readBy: IMPORT_RECIPE,
        drawn: () => ++asked,
        drivenHere: () => {
          asked++;
          return false;
        },
      }),
    );
    // Every open of every already-read chat runs this; a count over the whole
    // log here was paid on each one (bw-m8o.14).
    expect(asked).toBe(0);
  });

  it('asks nothing about how many rows a chat has when it is already marked', () => {
    let counted = 0;
    howToRead(chat({ readBy: IMPORT_RECIPE - 1, drawn: () => ++counted, drivenHere: () => true }));
    expect(counted).toBe(0);
  });
});

describe('what the second reading gives the reader', () => {
  it('drops the harness lines the first reading kept', () => {
    // Why re-reading is worth the trouble: reading 1 kept every line in the
    // record, and these are the ones nobody said.
    const record = [
      'do the thing',
      '<system-reminder>remember your rules</system-reminder>',
      'done',
      '<task-notification>an agent finished</task-notification>',
      '<local-command-stdout>ok</local-command-stdout>',
    ];
    expect(record.filter(saidByAnyone)).toEqual(['do the thing', 'done']);
  });
});
