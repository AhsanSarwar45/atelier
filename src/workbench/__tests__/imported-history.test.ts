/**
 * What comes back when a chat's past is read into the transcript.
 *
 * The examples are taken from a real record: the openings measured in one
 * Corsetta chat were `<command-name>/compact</command-name>`,
 * `<local-command-stdout>…` and `<task-notification>…` (bw-p61.3).
 */
import { describe, expect, it } from 'vitest';

import { saidByAnyone, textOf } from '@/workbench/imported-history';

describe('reading a chat’s past', () => {
  it('keeps what a person or an agent said', () => {
    expect(saidByAnyone('continue working on bw-7ks')).toBe(true);
    expect(saidByAnyone('Done — all five, on your board.')).toBe(true);
  });

  it('drops the lines the harness wrote', () => {
    expect(saidByAnyone('<task-notification>\n<task-id>b4qg1</task-id>')).toBe(false);
    expect(saidByAnyone('<command-name>/compact</command-name>')).toBe(false);
    expect(saidByAnyone('<local-command-stdout>Compacted</local-command-stdout>')).toBe(false);
    expect(saidByAnyone('<system-reminder>the board says…</system-reminder>')).toBe(false);
    expect(saidByAnyone('  \n<task-notification>')).toBe(false);
  });

  it('keeps a message that merely mentions one of those later on', () => {
    expect(saidByAnyone('The build finished; the <task-notification> arrived after it.')).toBe(true);
  });

  it('keeps nothing out of an empty message', () => {
    expect(saidByAnyone('')).toBe(false);
  });

  it('reads the words out of either shape a message comes in', () => {
    expect(textOf({ content: 'plain words' })).toBe('plain words');
    expect(
      textOf({
        content: [
          { type: 'thinking', thinking: 'not for the reader' },
          { type: 'text', text: 'the answer' },
        ],
      }),
    ).toBe('the answer');
    expect(textOf({ content: [{ type: 'tool_use', name: 'Bash' }] })).toBe('');
    expect(textOf(null)).toBe('');
  });
});
