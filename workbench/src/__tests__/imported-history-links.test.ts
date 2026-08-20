/**
 * @vitest-environment node
 *
 * A chat read in from its own record brings its reports and its tickets.
 *
 * The links are made by watching, never by asking: the live watcher hands every
 * tool call to the same Linker as it happens. A chat this app never watched has
 * no live calls to hand it — its calls are only in the agent kit's record — so
 * unless reading that record feeds the very same calls to the very same rules,
 * a chat opened for the first time draws with no cards and no reports on its
 * line, whatever it worked on (bw-khe.10, docs/agent-workbench.md §6.3.2).
 *
 * So what is proved here is a sameness: the events a record produces are the
 * events the live watcher would have produced from the same turns.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const KNOWN = new Set(['bw-khe', 'bw-khe.10']);
const recorded: { id: string; sessionId: string }[] = [];

vi.mock('../bd.ts', () => ({
  issueExists: (id: string) => Promise.resolve({ exists: KNOWN.has(id) }),
  recordTranscriptLink: (id: string, sessionId: string) => {
    recorded.push({ id, sessionId });
    return Promise.resolve();
  },
}));

const { Linker } = await import('../linker.ts');
const { linkPast } = await import('../../../src/workbench/imported-history.ts');

const SESSION = 'sess-1111-2222';
const CWD = '/home/me/project';

/** One recorded message carrying the calls a turn made. */
function turn(...calls: { name: string; input: Record<string, unknown> }[]) {
  return {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'doing the work' },
        ...calls.map((c) => ({ type: 'tool_use', name: c.name, input: c.input })),
      ],
    },
  };
}

const CLAIMED = { name: 'Bash', input: { command: 'bd update bw-khe.10 --claim' } };
const WROTE_REPORT = {
  name: 'Write',
  input: { file_path: '/data/reports/beads-web/a-chat-brings-its-links.report.json' },
};
const TOUCHED_NOTHING = { name: 'Read', input: { file_path: '/home/me/project/README.md' } };

/** Everything the Linker said, once the board has been asked and answered. */
async function eventsFrom(feed: (link: InstanceType<typeof Linker>) => void) {
  const said: { type: string; [k: string]: unknown }[] = [];
  const link = new Linker(SESSION, CWD, (e) => said.push(e as never));
  feed(link);
  // The board is asked behind the call; these are the answers landing.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return said;
}

/** The record of a chat that claimed a card and wrote a report. */
const RECORD = [
  { type: 'user', message: { content: 'do the thing' } },
  turn(CLAIMED, TOUCHED_NOTHING),
  turn(WROTE_REPORT),
];

/** Read in from the record, the way opening a never-watched chat does. */
const fromRecord = (link: InstanceType<typeof Linker>) => {
  linkPast(RECORD, (name, input) => link.observe(name, input));
};

/** Watched as it happened, one call at a time. */
const fromLive = (link: InstanceType<typeof Linker>) => {
  for (const call of [CLAIMED, TOUCHED_NOTHING, WROTE_REPORT]) link.observe(call.name, call.input);
};

describe('a chat read in from its record', () => {
  beforeEach(() => {
    recorded.length = 0;
  });

  it('says exactly what watching the same turns live would say', async () => {
    const read = await eventsFrom(fromRecord);
    const watched = await eventsFrom(fromLive);
    expect(read).toEqual(watched);
  });

  it('brings the report the chat wrote', async () => {
    expect(await eventsFrom(fromRecord)).toContainEqual({
      type: 'report.available',
      project: 'beads-web',
      slug: 'a-chat-brings-its-links',
    });
  });

  it('brings the ticket the chat worked on', async () => {
    expect(await eventsFrom(fromRecord)).toContainEqual({
      type: 'link.bead',
      beadId: 'bw-khe.10',
      via: 'tool',
    });
  });

  it('writes the link onto the board, not only onto the screen', async () => {
    await eventsFrom(fromRecord);
    expect(recorded).toEqual([{ id: 'bw-khe.10', sessionId: SESSION }]);
  });

  it('brings nothing from a turn that only read a file', async () => {
    const said = await eventsFrom((link) => link.observe(TOUCHED_NOTHING.name, TOUCHED_NOTHING.input));
    expect(said).toEqual([]);
  });

  it('leaves out a token the board does not know', async () => {
    const said = await eventsFrom((link) =>
      link.observe('Bash', { command: 'bd show zz-notreal.4' }),
    );
    expect(said).toEqual([]);
  });

  it('says a report named twice in the record once', async () => {
    const said = await eventsFrom((link) =>
      linkPast([turn(WROTE_REPORT), turn(WROTE_REPORT)], (name, input) => link.observe(name, input)),
    );
    expect(said.filter((e) => e.type === 'report.available')).toHaveLength(1);
  });
});
