/**
 * What comes back when a chat's past is read into the transcript.
 *
 * The examples are taken from a real record: the openings measured in one
 * Corsetta chat were `<command-name>/compact</command-name>`,
 * `<local-command-stdout>…` and `<task-notification>…` (bw-p61.3).
 */
import { describe, expect, it } from 'vitest';

import { cut, KEPT, pastTranscript, resultText, saidByAnyone, textOf, trimInput } from '@/workbench/imported-history';

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

/**
 * The rule the manager photographed: the same chat showed every command and its
 * output in his terminal, and sentences alone here (bw-1u1, §6.3.2).
 */
describe('a chat’s past comes back with its commands', () => {
  const record = [
    { type: 'user', message: { content: 'run the build' } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Running it.' },
          { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'npm run build' } },
        ],
      },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'built in 4s' }] },
    },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
  ];

  it('gives back the words and the commands in the order they happened', () => {
    expect(pastTranscript(record).map((e) => (e.kind === 'said' ? `${e.role}: ${e.text}` : `ran ${e.name}`))).toEqual([
      'user: run the build',
      'assistant: Running it.',
      'ran Bash',
      'assistant: Done.',
    ]);
  });

  it('carries what each command printed, so an old row opens like a live one', () => {
    const call = pastTranscript(record).find((e) => e.kind === 'call');
    expect(call).toMatchObject({ id: 'call-1', name: 'Bash', output: 'built in 4s', ok: true });
    expect(call && call.kind === 'call' && call.input).toEqual({ command: 'npm run build' });
  });

  it('marks a command whose result the record does not hold as neither failed nor finished badly', () => {
    const cut = record.slice(0, 2);
    expect(pastTranscript(cut).find((e) => e.kind === 'call')).toMatchObject({ output: '', ok: true });
  });

  it('still drops the words the harness wrote, and keeps what the chat ran', () => {
    const noisy = [
      { type: 'user', message: { content: '<task-notification>\n<task-id>b4qg1</task-id>' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c', name: 'Read', input: {} }] } },
    ];
    expect(pastTranscript(noisy).map((e) => e.kind)).toEqual(['call']);
  });
});

/**
 * What an opened command row prints. The browser used to throw command output
 * away, so a result carrying a picture was never read by anyone; the moment the
 * row started opening onto it, a screenshot became a wall of base64 where the
 * picture belongs (bw-1u1.30).
 */
describe('what a command printed', () => {
  it('gives back plain output as it stands', () => {
    expect(resultText('built in 4s')).toBe('built in 4s');
  });

  it('joins the words out of a result that came back in blocks', () => {
    expect(
      resultText([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ]),
    ).toBe('first\nsecond');
  });

  it('names and measures a picture instead of printing its bytes', () => {
    const printed = resultText([
      { type: 'text', text: 'Here is the screen:' },
      { type: 'image', source: { media_type: 'image/png', data: 'A'.repeat(40_000) } },
    ]);
    expect(printed).toBe('Here is the screen:\n[image/png, 29 KB]');
    expect(printed.length).toBeLessThan(80);
  });

  it('names a kind of block it has never seen, rather than unrolling it', () => {
    expect(resultText([{ type: 'document', source: { data: 'B'.repeat(9_000) } }])).toBe('[document]');
  });

  it('keeps nothing out of a result that carries nothing', () => {
    expect(resultText(null)).toBe('');
    expect(resultText(undefined)).toBe('');
  });
});

/**
 * What a command was ASKED to do, which is the other half of the same row.
 *
 * Output was cut in two places and arguments in none, so the first sizeable
 * file the agent wrote opened the row onto every byte of it — and an imported
 * chat wrote every byte into the stored history too (bw-1u1.33).
 */
describe('what a command was asked to do', () => {
  const aBigFile = 'x'.repeat(50_000);

  it('cuts a value to the same length the output is cut to, and says how much went', () => {
    const trimmed = trimInput({ file_path: '/tmp/big.txt', content: aBigFile });
    expect(trimmed.file_path).toBe('/tmp/big.txt');
    expect(String(trimmed.content)).toHaveLength(KEPT + '\n… and 46000 more characters'.length);
    expect(String(trimmed.content)).toContain('… and 46000 more characters');
  });

  it('leaves a command small enough to read exactly as it stands', () => {
    expect(trimInput({ command: 'npm run build' })).toEqual({ command: 'npm run build' });
  });

  it('reaches the values inside a list of edits, where the whole file also hides', () => {
    const trimmed = trimInput({ edits: [{ old_string: aBigFile, new_string: 'small' }] });
    const edits = trimmed.edits as { old_string: string; new_string: string }[];
    expect(edits[0]!.old_string.length).toBeLessThan(aBigFile.length);
    expect(edits[0]!.new_string).toBe('small');
  });

  it('cuts nothing that is already short, whatever shape it is', () => {
    expect(cut('short')).toBe('short');
    expect(trimInput({ n: 7, on: true, nothing: null })).toEqual({ n: 7, on: true, nothing: null });
  });
});
