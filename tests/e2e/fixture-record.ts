import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * A chat's record on disk, written the way the kit writes one, for a chat this
 * app has never run.
 *
 * The one thing a live case cannot produce. Driving a real agent proves the
 * wire; what is proved here is the OTHER reading — a conversation that happened
 * somewhere else, found on disk afterwards, with an agent it sent off whose
 * turns the kit filed in a second file beside it (bw-7ks.22.7). A chat the app
 * drove has an event log of its own and is replayed from that, so it can never
 * exercise this path however many times it is restarted.
 *
 * The shapes are the kit's own, taken from a record on this machine
 * (2026-08-20, kit 2.1.237): the chat's file names the helper by one call and
 * one answer, and everything the helper itself said is in
 * `<chat>/subagents/agent-<id>.jsonl`, with `agent-<id>.meta.json` naming the
 * call that sent it off.
 */

/** The call in the chat that sends the helper away. Named by both files. */
export const SENT_OFF_CALL = 'toolu_01FixtureSentItOff';

/** The kit's name for the piece of work, which is also its file's name. */
export const HELPER_AGENT = 'fixture-helper-1';

/** What the helper was asked to do, in the sender's own words. */
export const HELPER_BRIEF = 'Count the cards on the board';

/** The sentence the helper writes before it starts. Its own, never the chat's. */
export const HELPER_SAID = 'Reading the board now.';

/** The helper's last word, which is what its row shows once it is over. */
export const HELPER_ANSWERED = 'Three cards, one of them closed.';

/** The chat's own answer, which no helper said. */
export const CHAT_SAID = 'Three cards on the board.';

/** What one turn cost, so a row has a spend to draw. */
const SPENT = {
  input_tokens: 120,
  cache_creation_input_tokens: 900,
  cache_read_input_tokens: 400,
  output_tokens: 180,
};

/** Where the kit keeps its records, honouring a config dir set for a run. */
export function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/** The folder the kit files a project's chats under: its path, punctuation flattened. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

export interface WrittenRecord {
  /** The conversation's own id, which is what a row is found by. */
  sessionId: string;
  /** The chat's own file. */
  path: string;
  /** Everything written, so a run can take it away again. */
  remove: () => void;
}

/**
 * Writes one chat that sent one helper away, and returns what it wrote.
 *
 * `card` is a card on the fixture's own board that ONLY the helper touches —
 * the chat's own turns never name it — so a chip for it on the chat can have
 * come from nowhere else.
 */
export function writeChatWithHelper(opts: {
  cwd: string;
  sessionId: string;
  branch?: string;
  card: string;
  at?: Date;
}): WrittenRecord {
  const { cwd, sessionId, card } = opts;
  const branch = opts.branch ?? 'main';
  const began = opts.at ?? new Date(Date.now() - 60 * 60 * 1000);
  const when = (seconds: number): string => new Date(began.getTime() + seconds * 1000).toISOString();

  const dir = join(configDir(), 'projects', projectSlug(cwd));
  const path = join(dir, `${sessionId}.jsonl`);
  const helpers = join(dir, sessionId, 'subagents');
  mkdirSync(helpers, { recursive: true });

  const stamp = (extra: Record<string, unknown>, seconds: number): Record<string, unknown> => ({
    sessionId,
    cwd,
    gitBranch: branch,
    version: '2.1.237',
    userType: 'external',
    timestamp: when(seconds),
    ...extra,
  });

  // The chat's own record: it asks, it delegates, it hears one answer back, it
  // replies. The helper's own words are in none of it — that is the point.
  const chat = [
    stamp(
      {
        parentUuid: null,
        uuid: 'fixture-u1',
        type: 'user',
        message: { role: 'user', content: `${HELPER_BRIEF}, by sending one agent off to do it.` },
      },
      0,
    ),
    stamp(
      {
        parentUuid: 'fixture-u1',
        uuid: 'fixture-u2',
        type: 'assistant',
        message: {
          id: 'msg_fixture_1',
          model: 'claude-opus-5',
          role: 'assistant',
          usage: SPENT,
          content: [
            {
              type: 'tool_use',
              id: SENT_OFF_CALL,
              name: 'Task',
              input: { subagent_type: 'general-purpose', description: HELPER_BRIEF, prompt: HELPER_BRIEF },
            },
          ],
        },
      },
      2,
    ),
    stamp(
      {
        parentUuid: 'fixture-u2',
        uuid: 'fixture-u3',
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: SENT_OFF_CALL, content: HELPER_ANSWERED }],
        },
      },
      50,
    ),
    stamp(
      {
        parentUuid: 'fixture-u3',
        uuid: 'fixture-u4',
        type: 'assistant',
        message: {
          id: 'msg_fixture_2',
          model: 'claude-opus-5',
          role: 'assistant',
          usage: SPENT,
          content: [{ type: 'text', text: CHAT_SAID }],
        },
      },
      52,
    ),
  ];

  // The helper's own conversation, in its own file: what it was told, a
  // sentence of its own, the command it ran — which names the card nothing
  // else in this chat names — and what it answered.
  const sidechain = (extra: Record<string, unknown>, seconds: number): Record<string, unknown> =>
    stamp({ isSidechain: true, agentId: HELPER_AGENT, ...extra }, seconds);
  const helper = [
    sidechain(
      { parentUuid: null, uuid: 'fixture-h1', type: 'user', message: { role: 'user', content: HELPER_BRIEF } },
      3,
    ),
    sidechain(
      {
        parentUuid: 'fixture-h1',
        uuid: 'fixture-h2',
        type: 'assistant',
        message: {
          id: 'msg_fixture_h1',
          model: 'claude-fable-5',
          role: 'assistant',
          usage: SPENT,
          content: [{ type: 'text', text: HELPER_SAID }],
        },
      },
      8,
    ),
    sidechain(
      {
        parentUuid: 'fixture-h2',
        uuid: 'fixture-h3',
        type: 'assistant',
        message: {
          id: 'msg_fixture_h2',
          model: 'claude-fable-5',
          role: 'assistant',
          usage: SPENT,
          content: [
            { type: 'tool_use', id: 'toolu_fixtureHelperRan', name: 'Bash', input: { command: `bd show ${card}` } },
          ],
        },
      },
      20,
    ),
    sidechain(
      {
        parentUuid: 'fixture-h3',
        uuid: 'fixture-h4',
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_fixtureHelperRan', content: `${card} is open.` }],
        },
      },
      30,
    ),
    sidechain(
      {
        parentUuid: 'fixture-h4',
        uuid: 'fixture-h5',
        type: 'assistant',
        message: {
          id: 'msg_fixture_h3',
          model: 'claude-fable-5',
          role: 'assistant',
          usage: SPENT,
          content: [{ type: 'text', text: HELPER_ANSWERED }],
        },
      },
      48,
    ),
  ];

  const asLines = (rows: Record<string, unknown>[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(path, asLines(chat));
  writeFileSync(join(helpers, `agent-${HELPER_AGENT}.jsonl`), asLines(helper));
  writeFileSync(
    join(helpers, `agent-${HELPER_AGENT}.meta.json`),
    JSON.stringify({
      agentType: 'general-purpose',
      description: HELPER_BRIEF,
      toolUseId: SENT_OFF_CALL,
      spawnDepth: 1,
    }) + '\n',
  );

  return {
    sessionId,
    path,
    remove: () => {
      rmSync(path, { force: true });
      rmSync(join(dir, sessionId), { recursive: true, force: true });
    },
  };
}
