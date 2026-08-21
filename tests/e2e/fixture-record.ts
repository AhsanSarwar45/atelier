import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * What a helper that came back red said last, and what its call came back with.
 *
 * A helper's own record says what it did and never whether it worked; the
 * answer is on the call that sent it, which comes back marked in error
 * (bw-7ks.22.28).
 */
export const HELPER_FAILED = 'I could not read the board: bd is not on the path.';

/** What one turn cost, so a row has a spend to draw. */
const SPENT = {
  input_tokens: 120,
  cache_creation_input_tokens: 900,
  cache_read_input_tokens: 400,
  output_tokens: 180,
};

/** The whole of one call, on the reading the rows and the chip both use. */
export const A_CALL = SPENT.input_tokens + SPENT.cache_creation_input_tokens + SPENT.cache_read_input_tokens + SPENT.output_tokens;

/** How many turns of its own each helper below is written with. */
export const HELPER_TURNS = 3;

/** Where the kit keeps its records, honouring a config dir set for a run. */
export function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/** The folder the kit files a project's chats under: its path, punctuation flattened. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

/** What the chat below was written having spent, so a case can check the sum. */
export interface WrittenSpend {
  /** The chat's own turns, and nothing it sent away. */
  own: number;
  /** Every agent it sent off, added up. */
  helpers: number;
  /** The two together, which is what the chat's own line has to say. */
  total: number;
}

/**
 * An agent the chat sends off AFTER somebody has opened it for reading
 * (bw-7ks.22.19).
 *
 * The two files move the way the kit moves them: the call goes into the chat's
 * own record the moment it is sent, everything the agent says goes into its own
 * file beside it as it says it, and the answer comes back into the chat's
 * record last of all.
 */
export interface SentOffLater {
  /** The call in the chat that sent it off. */
  call: string;
  /** The kit's name for it, which is also its file's name. */
  agentId: string;
  /** It says something of its own, into its own file and nowhere else. */
  says(text: string): void;
  /**
   * It answers, and the chat hears that answer back: the row is over. `ok`
   * false marks that answer in error, which is the only place how it went is
   * ever written down.
   */
  answers(text: string, ok?: boolean): void;
}

export interface WrittenRecord {
  /** The conversation's own id, which is what a row is found by. */
  sessionId: string;
  /** The chat's own file. */
  path: string;
  /** The calls that sent each helper off, in the order they went. */
  calls: string[];
  /** What was written, added up both ways. */
  spend: WrittenSpend;
  /** The chat sends another agent off, as it would while a reader watched. */
  sendsOff(brief?: string): SentOffLater;
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
  /** How many agents this chat sent off. One unless a case needs a panel. */
  sentOff?: number;
  /** Which of them came back red, if one did: the call that sent it is in error. */
  souredAt?: number;
}): WrittenRecord {
  const { cwd, sessionId, card } = opts;
  const branch = opts.branch ?? 'main';
  const many = opts.sentOff ?? 1;
  const soured = opts.souredAt ?? -1;
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

  /** The call that sends off the nth helper, and the file that helper writes. */
  const callOf = (n: number): string => (n === 0 ? SENT_OFF_CALL : `${SENT_OFF_CALL}${n + 1}`);
  const agentOf = (n: number): string => (n === 0 ? HELPER_AGENT : `${HELPER_AGENT}-${n + 1}`);
  const calls = Array.from({ length: many }, (_, n) => callOf(n));

  // The chat's own record: it asks, it delegates, it hears each answer back, it
  // replies. No helper's own words are in any of it — that is the point.
  const chat: Record<string, unknown>[] = [
    stamp(
      {
        parentUuid: null,
        uuid: 'fixture-u1',
        type: 'user',
        message: { role: 'user', content: `${HELPER_BRIEF}, by sending ${many} agent(s) off to do it.` },
      },
      0,
    ),
  ];
  for (let n = 0; n < many; n++) {
    chat.push(
      stamp(
        {
          parentUuid: `fixture-u${n * 2 + 1}`,
          uuid: `fixture-u${n * 2 + 2}`,
          type: 'assistant',
          message: {
            id: `msg_fixture_sent_${n}`,
            model: 'claude-opus-5',
            role: 'assistant',
            usage: SPENT,
            content: [
              {
                type: 'tool_use',
                id: callOf(n),
                name: 'Task',
                input: { subagent_type: 'general-purpose', description: HELPER_BRIEF, prompt: HELPER_BRIEF },
              },
            ],
          },
        },
        2 + n,
      ),
      stamp(
        {
          parentUuid: `fixture-u${n * 2 + 2}`,
          uuid: `fixture-u${n * 2 + 3}`,
          type: 'user',
          message: {
            role: 'user',
            content: [
              n === soured
                ? { type: 'tool_result', tool_use_id: callOf(n), is_error: true, content: HELPER_FAILED }
                : { type: 'tool_result', tool_use_id: callOf(n), content: HELPER_ANSWERED },
            ],
          },
        },
        50 + n,
      ),
    );
  }
  chat.push(
    stamp(
      {
        parentUuid: `fixture-u${many * 2 + 1}`,
        uuid: `fixture-u${many * 2 + 2}`,
        type: 'assistant',
        message: {
          id: 'msg_fixture_last',
          model: 'claude-opus-5',
          role: 'assistant',
          usage: SPENT,
          content: [{ type: 'text', text: CHAT_SAID }],
        },
      },
      52 + many,
    ),
  );

  // Each helper's own conversation, in its own file: what it was told, a
  // sentence of its own, the command it ran — which names the card nothing
  // else in this chat names — and what it answered.
  const asLines = (rows: Record<string, unknown>[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  for (let n = 0; n < many; n++) {
    const agentId = agentOf(n);
    const sidechain = (extra: Record<string, unknown>, seconds: number): Record<string, unknown> =>
      stamp({ isSidechain: true, agentId, ...extra }, seconds);
    const helper = [
      sidechain(
        { parentUuid: null, uuid: 'fixture-h1', type: 'user', message: { role: 'user', content: HELPER_BRIEF } },
        3 + n,
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
        8 + n,
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
              { type: 'tool_use', id: `toolu_fixtureHelperRan${n}`, name: 'Bash', input: { command: `bd show ${card}` } },
            ],
          },
        },
        20 + n,
      ),
      sidechain(
        {
          parentUuid: 'fixture-h3',
          uuid: 'fixture-h4',
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: `toolu_fixtureHelperRan${n}`, content: `${card} is open.` }],
          },
        },
        30 + n,
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
            content: [{ type: 'text', text: n === soured ? HELPER_FAILED : HELPER_ANSWERED }],
          },
        },
        48 + n,
      ),
    ];
    writeFileSync(join(helpers, `agent-${agentId}.jsonl`), asLines(helper));
    writeFileSync(
      join(helpers, `agent-${agentId}.meta.json`),
      JSON.stringify({
        agentType: 'general-purpose',
        description: HELPER_BRIEF,
        toolUseId: callOf(n),
        spawnDepth: 1,
      }) + '\n',
    );
  }

  writeFileSync(path, asLines(chat));

  // From here the chat is on disk and can be opened. What follows happens while
  // somebody is reading it: the record and the agents' own files are appended
  // to, exactly as the kit appends to them.
  let last = `fixture-u${many * 2 + 2}`;
  let later = 0;
  const now = (): string => new Date().toISOString();
  const append = (file: string, row: Record<string, unknown>): void =>
    appendFileSync(file, JSON.stringify(row) + '\n');

  const sendsOff = (brief = HELPER_BRIEF): SentOffLater => {
    const n = later++;
    const call = `${SENT_OFF_CALL}Later${n}`;
    const agentId = `${HELPER_AGENT}-later-${n}`;
    const file = join(helpers, `agent-${agentId}.jsonl`);
    let mine = `${agentId}-h0`;

    // The call, in the chat's own record. Its answer is not here yet, which is
    // the shape a record ends in while an agent is still working.
    const sent = `fixture-later-u${n}`;
    append(path, {
      sessionId,
      cwd,
      gitBranch: branch,
      version: '2.1.237',
      userType: 'external',
      timestamp: now(),
      parentUuid: last,
      uuid: sent,
      type: 'assistant',
      message: {
        id: `msg_fixture_later_${n}`,
        model: 'claude-opus-5',
        role: 'assistant',
        usage: SPENT,
        content: [
          { type: 'tool_use', id: call, name: 'Task', input: { subagent_type: 'general-purpose', description: brief, prompt: brief } },
        ],
      },
    });
    last = sent;

    /** One line of the agent's own conversation, into its own file. */
    let saidSoFar = 0;
    const mineIs = (extra: Record<string, unknown>): void => {
      const uuid = `${agentId}-h${++saidSoFar}`;
      append(file, {
        sessionId,
        cwd,
        gitBranch: branch,
        version: '2.1.237',
        userType: 'external',
        timestamp: now(),
        isSidechain: true,
        agentId,
        parentUuid: mine,
        uuid,
        ...extra,
      });
      mine = uuid;
    };

    // Its file exists from the moment it is sent, holding the brief it was
    // given — which is how anything watching knows it went off at all.
    writeFileSync(file, '');
    append(file, {
      sessionId,
      cwd,
      timestamp: now(),
      isSidechain: true,
      agentId,
      parentUuid: null,
      uuid: mine,
      type: 'user',
      message: { role: 'user', content: brief },
    });
    writeFileSync(
      join(helpers, `agent-${agentId}.meta.json`),
      JSON.stringify({ agentType: 'general-purpose', description: brief, toolUseId: call, spawnDepth: 1 }) + '\n',
    );

    return {
      call,
      agentId,
      says: (text: string): void =>
        mineIs({
          type: 'assistant',
          message: { id: `msg_${agentId}_said`, model: 'claude-fable-5', role: 'assistant', usage: SPENT, content: [{ type: 'text', text }] },
        }),
      answers: (text: string, ok = true): void => {
        mineIs({
          type: 'assistant',
          message: { id: `msg_${agentId}_answer`, model: 'claude-fable-5', role: 'assistant', usage: SPENT, content: [{ type: 'text', text }] },
        });
        const back = `fixture-later-u${n}-back`;
        append(path, {
          sessionId,
          cwd,
          gitBranch: branch,
          version: '2.1.237',
          userType: 'external',
          timestamp: now(),
          parentUuid: last,
          uuid: back,
          type: 'user',
          message: {
            role: 'user',
            content: [ok ? { type: 'tool_result', tool_use_id: call, content: text } : { type: 'tool_result', tool_use_id: call, is_error: true, content: text }],
          },
        });
        last = back;
      },
    };
  };

  // The chat answered once per helper it sent off and once at the end; each
  // helper answered three times of its own.
  const own = (many + 1) * A_CALL;
  const sentAway = many * HELPER_TURNS * A_CALL;
  return {
    sessionId,
    path,
    calls,
    spend: { own, helpers: sentAway, total: own + sentAway },
    sendsOff,
    remove: () => {
      rmSync(path, { force: true });
      rmSync(join(dir, sessionId), { recursive: true, force: true });
    },
  };
}
