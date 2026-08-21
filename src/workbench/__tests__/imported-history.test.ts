/**
 * What comes back when a chat's past is read into the transcript.
 *
 * The examples are taken from a real record: the openings measured in one
 * Corsetta chat were `<command-name>/compact</command-name>`,
 * `<local-command-stdout>…` and `<task-notification>…` (bw-p61.3).
 */
import { describe, expect, it } from 'vitest';

import {
  cut,
  IMPORT_RECIPE,
  KEPT,
  type PastEntry,
  pastTranscript,
  PICTURE_KEPT,
  resultText,
  saidByAnyone,
  saidWithPictures,
  settledUpTo,
  textOf,
  trimInput,
} from '@/workbench/imported-history';

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
 * A picture pasted into a chat, read back out of that chat's own record.
 *
 * What the manager saw on 2026-08-20 was the bare words `[Image #1]` sitting in
 * his own message with nothing to click: the record kept the picture in a block
 * of its own, and reading the words alone threw it away (bw-uu9x).
 */
describe('a picture in a message comes back with it', () => {
  /** A one-pixel PNG, small enough to write out here in full. */
  const PIXEL =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const pasted = (data = PIXEL, mime = 'image/png') => ({
    type: 'image',
    source: { type: 'base64', media_type: mime, data },
  });

  it('carries the picture and lifts the harness’s marker out of the words', () => {
    const said = saidWithPictures({
      content: [{ type: 'text', text: 'look at this [Image #1] and tell me why' }, pasted()],
    });
    expect(said.images).toHaveLength(1);
    expect(said.images[0]).toMatchObject({ mime: 'image/png', dataUrl: `data:image/png;base64,${PIXEL}` });
    expect(said.text).toBe('look at this and tell me why');
    expect(said.text).not.toContain('[Image #');
  });

  it('gives a whole message back as one row, its picture beside its words', () => {
    const rows = pastTranscript([
      {
        type: 'user',
        message: { content: [{ type: 'text', text: 'why is this broken [Image #1]' }, pasted()] },
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'said', role: 'user', text: 'why is this broken' });
    expect(rows[0]!.kind === 'said' && rows[0]!.images).toHaveLength(1);
  });

  it('carries every picture a message holds, in the order it holds them', () => {
    const said = saidWithPictures({
      content: [
        { type: 'text', text: 'before [Image #1] after [Image #2] end' },
        pasted(),
        pasted(PIXEL, 'image/jpeg'),
      ],
    });
    expect(said.images.map((i) => i.mime)).toEqual(['image/png', 'image/jpeg']);
    expect(said.text).toBe('before after end');
  });

  /**
   * The number in a marker counts the pictures of the whole conversation, not
   * the blocks of the one message. A record of this project's own holds a
   * message whose blocks run png then jpeg while its words read
   * '…[Image #2]…[Image #1]', with the png being the one the prose calls #2. So
   * nothing may be decided from that number (bw-uu9x.6).
   */
  it('does not read the marker’s number as the picture’s place in the message', () => {
    const said = saidWithPictures({
      content: [
        { type: 'text', text: 'the error [Image #2] and the settings [Image #1]' },
        pasted(),
        pasted(PIXEL, 'image/jpeg'),
      ],
    });
    expect(said.images.map((i) => i.mime)).toEqual(['image/png', 'image/jpeg']);
    expect(said.text).toBe('the error and the settings');
  });

  it('accounts for an uncarried picture even where the numbers run backwards', () => {
    const huge = 'A'.repeat(PICTURE_KEPT + 4);
    const said = saidWithPictures({
      content: [
        { type: 'text', text: 'the error [Image #2] and the settings [Image #1]' },
        pasted(huge),
        pasted(PIXEL, 'image/jpeg'),
      ],
    });
    // The one that fits is drawn; the one that does not is named — and neither
    // is guessed at from a marker number that means something else.
    expect(said.images.map((i) => i.mime)).toEqual(['image/jpeg']);
    expect(said.text).toBe('the error and the settings\n[image/png, 732 KB]');
  });

  /**
   * A message that pastes a screenshot beside an aligned table or a snippet is
   * still that table and that snippet: only the lines a marker stood on may be
   * touched by lifting one out (bw-uu9x.7).
   */
  it('closes a sentence up once where two markers were pasted back to back', () => {
    const said = saidWithPictures({
      content: [
        { type: 'text', text: 'compare [Image #1][Image #2] these' },
        pasted(),
        pasted(PIXEL, 'image/jpeg'),
      ],
    });
    expect(said.text).toBe('compare these');
  });

  it('leaves the spacing of every line the marker was not on alone', () => {
    const said = saidWithPictures({
      content: [
        { type: 'text', text: 'see [Image #1]\nname     count\nbuild        4\n' },
        pasted(),
      ],
    });
    expect(said.text).toBe('see\nname     count\nbuild        4');
  });

  it('draws a message that is a picture and nothing else', () => {
    const rows = pastTranscript([{ type: 'user', message: { content: [pasted()] } }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'said', text: '' });
    expect(rows[0]!.kind === 'said' && rows[0]!.images).toHaveLength(1);
  });

  it('names and measures a picture too big to carry instead of carrying it', () => {
    const huge = 'A'.repeat(PICTURE_KEPT + 4);
    const said = saidWithPictures({
      content: [{ type: 'text', text: 'this one [Image #1] please' }, pasted(huge)],
    });
    expect(said.images).toHaveLength(0);
    expect(said.text).toBe('this one please\n[image/png, 732 KB]');
  });

  it('names a picture the record holds somewhere else rather than as bytes', () => {
    const said = saidWithPictures({
      content: [
        { type: 'text', text: 'here [Image #1]' },
        { type: 'image', source: { type: 'url', media_type: 'image/png', url: 'https://x/y.png' } },
      ],
    });
    expect(said.images).toHaveLength(0);
    expect(said.text).toBe('here\n[image/png, 0 bytes]');
  });

  it('leaves a message with no picture in it exactly as it was', () => {
    const said = saidWithPictures({ content: [{ type: 'text', text: 'nothing pasted here' }] });
    expect(said).toEqual({ text: 'nothing pasted here', images: [] });
    expect(saidWithPictures({ content: 'plain words' })).toEqual({ text: 'plain words', images: [] });
  });

  it('reads every chat again, because one read before this drew no pictures', () => {
    // A floor rather than a number: the pictures went in at 6, and a later
    // reading that raises it again re-reads these chats too. Pinning the
    // number would fail the next honest bump and say nothing about pictures.
    expect(IMPORT_RECIPE).toBeGreaterThanOrEqual(6);
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

describe('how much of a record still being written may be drawn', () => {
  const said = (text: string): PastEntry => ({ kind: 'said', role: 'assistant', text, images: [] });
  const call = (id: string, output: string): PastEntry => ({
    kind: 'call',
    id,
    name: 'Bash',
    input: {},
    output,
    ok: true,
    at: null,
  });

  it('draws all of a record whose last entry is a finished command', () => {
    const entries = [said('running the tests'), call('t1', '282 passed')];
    expect(settledUpTo(entries)).toBe(2);
  });

  it('holds back a command whose answer has not landed yet', () => {
    const entries = [said('running the tests'), call('t1', '')];
    expect(settledUpTo(entries)).toBe(1);
  });

  it('holds back the whole run of them, not merely the last', () => {
    const entries = [said('two at once'), call('t1', ''), call('t2', '')];
    expect(settledUpTo(entries)).toBe(1);
  });

  // The delay this costs: a command that really did print nothing waits for
  // whatever the chat says next, and is then drawn like any other.
  it('draws a command that printed nothing once something follows it', () => {
    const entries = [call('t1', ''), said('done')];
    expect(settledUpTo(entries)).toBe(2);
  });

  it('draws a record that ends in words, whatever came before', () => {
    const entries = [call('t1', ''), call('t2', 'ok'), said('that is all')];
    expect(settledUpTo(entries)).toBe(3);
  });

  it('says nothing may be drawn out of nothing', () => {
    expect(settledUpTo([])).toBe(0);
    expect(settledUpTo([call('t1', '')])).toBe(0);
  });
});
