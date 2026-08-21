/**
 * The third door: what the kit writes in HIS name.
 *
 * Two doors were shut before this one. A message ABOUT the run arrives with a
 * kind and a state on it, and the table of English sorts it. A run's own answer
 * that is really one of the kit's sentences is caught where the answer is
 * drawn. This is the third: the kit opens a message with the role `user` — his
 * side of the page, his colour — and writes something itself.
 *
 * Sixty-three of the 526 messages standing in the manager's name are these, and
 * one shape of them was recognised: a single line in square brackets. So a
 * whole background-task report, five paragraphs long and opening "NOT USER
 * INPUT", was drawn as five paragraphs he had typed — twenty-one times. The
 * kit's note about a picture he pasted was drawn as an interrupt, seven times.
 *
 * Recognised by SHAPE and never by wording: the wordings are the kit's and
 * change without us. And three of these are HIS after all, wrapped — a slash
 * command, a line he sent mid-turn, the one line he asked a worker for — so
 * those come back as his own words with the wrapper taken off, which is the
 * half of this that a rule written only to hide things would get wrong.
 */
import { describe, expect, it } from 'vitest';

import { drawnRows } from '@/workbench/machine-lines';
import { notHisWords } from '@/workbench/machine-words';
import type { TranscriptItem } from '@/workbench/use-session';

/** A message as it arrives from the chat: his own, or one written in his name. */
const typed = (text: string): TranscriptItem => ({
  kind: 'message',
  id: `typed-${text.slice(0, 24)}`,
  role: 'user',
  text,
  parentId: null,
  images: [],
  done: true,
});

/** What one message is drawn as: a machine line, or his own words. */
const drawn = (text: string) => {
  const row = drawnRows([typed(text)])[0];
  return row.row === 'machine'
    ? { row: 'machine' as const, kind: row.kind, family: row.family, text: row.lines[0]!.text }
    : { row: 'other' as const, kind: null, family: null, text: row.item.kind === 'message' ? row.item.text : '' };
};

const AGENT_CAME_HOME = [
  '[SYSTEM NOTIFICATION - NOT USER INPUT]',
  '',
  '<status>completed</status>',
  '<summary>Read the file and found nothing</summary>',
].join('\n');

const AGENT_FAILED = [
  '[SYSTEM NOTIFICATION - NOT USER INPUT]',
  '',
  '<status>failed</status>',
  '<summary>The helper could not open the file</summary>',
].join('\n');

describe('a background agent reporting back', () => {
  it('is a machine line, not five paragraphs he typed', () => {
    expect(drawn(AGENT_CAME_HOME)).toMatchObject({ row: 'machine', kind: 'system/task_notification' });
  });

  it('says what the agent said, and never the wrapper around it', () => {
    const line = drawn(AGENT_CAME_HOME).text;
    expect(line).toBe('Read the file and found nothing.');
    expect(line).not.toContain('NOT USER INPUT');
  });

  it('goes to him when the agent failed and to the machine when it did not', () => {
    // His ruling, 2026-08-20: the panel is the list of agents, so the chat says
    // nothing about one unless it failed.
    expect(drawn(AGENT_FAILED).family).toBe('failed');
    expect(drawn(AGENT_CAME_HOME).family).toBe('background');
  });

  it('still says something when the report carries no summary', () => {
    const bare = '[SYSTEM NOTIFICATION - NOT USER INPUT]\n\n<status>failed</status>';
    expect(drawn(bare).text).toBe('A sent-off agent failed.');
  });
});

describe('the kit’s own notes in his colour', () => {
  it('says he pasted a picture, rather than reading its size out at him', () => {
    expect(drawn('[Image: 1512x982 image/png]')).toMatchObject({
      row: 'machine',
      kind: 'user/pasted_image',
      text: 'You pasted a picture.',
    });
  });

  it('says a stop he asked for in English', () => {
    expect(drawn('[Request interrupted by user]').text).toBe('You stopped this run.');
    expect(drawn('[Request interrupted by user for tool use]').text).toBe('You stopped this run while a tool was going.');
  });

  it('quotes a marker this build has never met, rather than drawing it as his message', () => {
    expect(drawn('[Something the kit invented tomorrow]')).toMatchObject({
      row: 'machine',
      kind: 'user/synthetic',
      text: '[Something the kit invented tomorrow]',
    });
  });

  it('files a wrapper nobody has named yet as a note of the chat’s own', () => {
    expect(drawn('<system-reminder>The tests are still running.</system-reminder>')).toMatchObject({
      row: 'machine',
      kind: 'user/note',
    });
  });

  it('says what a command printed, with the terminal’s colours taken off', () => {
    const printed = `<local-command-stdout>${'\u001B[32m'}Everything is fine${'\u001B[0m'}\nsecond line</local-command-stdout>`;
    expect(drawn(printed)).toMatchObject({
      row: 'machine',
      kind: 'user/command_output',
      text: 'That command said: Everything is fine',
    });
  });
});

describe('the ones that are his after all', () => {
  it('gives him back the slash command he ran', () => {
    const wrapped = [
      '<command-name>/compact</command-name>',
      '<command-message>compact</command-message>',
      '<command-args>the chat sorting</command-args>',
    ].join('\n');
    expect(drawn(wrapped)).toMatchObject({ row: 'other', text: '/compact the chat sorting' });
  });

  it('gives him back the line he sent while the run was working', () => {
    const wrapped = [
      'The user sent a new message while you were working:',
      'stop and look at the screenshot',
      '',
      'This is how the kit passes on a message mid-turn, and it is not his.',
    ].join('\n');
    expect(drawn(wrapped)).toMatchObject({ row: 'other', text: 'stop and look at the screenshot' });
  });

  it('gives him back the one line he asked a worker for', () => {
    // Pages of standing orders to the machine, and then his own question at the
    // end of them. Filing the whole thing as a machine line would have hidden
    // the question with it.
    const brief = [
      '<fork-boilerplate>',
      'You are a worker fork. Execute ONE directive, then stop.',
      '</fork-boilerplate>',
      '',
      'Your directive: everything going well? any obstructions?',
    ].join('\n');
    expect(drawn(brief)).toMatchObject({ row: 'other', text: 'everything going well? any obstructions?' });
  });

  it('files the briefing as the machine’s when it carries no line of his', () => {
    const brief = '<fork-boilerplate>\nYou are a worker fork.\n</fork-boilerplate>';
    expect(drawn(brief)).toMatchObject({ row: 'machine', kind: 'user/fork_brief' });
  });

  it('leaves what he really typed exactly as he typed it', () => {
    expect(drawn('do the thing')).toMatchObject({ row: 'other', text: 'do the thing' });
    expect(drawn('see [the note] about it')).toMatchObject({ row: 'other', text: 'see [the note] about it' });
    expect(drawn('use <em>this</em> and then stop')).toMatchObject({ row: 'other' });
    expect(notHisWords('do the thing')).toBeNull();
  });
});
