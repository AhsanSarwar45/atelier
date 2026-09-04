import { appendFileSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

/**
 * Each agent a chat sends off, when it sends off more than one — and every one
 * of them different from its neighbours.
 *
 * A panel of three rows written from one template proves nothing: three
 * identical rows are what a screen drawing the FIRST row three times would look
 * like, and so are three rows drawn from a static picture. So each helper here
 * is asked something else, runs on another model, takes its own time and costs
 * its own money, and a case can hold every row to its own line (bw-7ks.22.29).
 *
 * The first is the one every single-helper case already knows.
 */
export const EACH_HELPER = [
  { brief: HELPER_BRIEF, said: HELPER_SAID, answer: HELPER_ANSWERED, model: 'claude-fable-5', seconds: 45, costs: 1 },
  {
    brief: 'Read the last report and say when it was written',
    said: 'Opening the report now.',
    answer: 'The last report is from Tuesday.',
    model: 'claude-opus-5',
    seconds: 90,
    costs: 2,
  },
  {
    brief: 'List the branches this work left behind',
    said: 'Listing the branches now.',
    answer: 'Two branches, both merged.',
    model: 'claude-haiku-4-5-20251001',
    seconds: 150,
    costs: 3,
  },
] as const;

/** Which of the above the nth agent a chat sent off is. */
export const helperNumber = (n: number): (typeof EACH_HELPER)[number] => EACH_HELPER[n % EACH_HELPER.length]!;

/** What that one's turn cost, which is its own and not its neighbour's. */
const spentBy = (n: number): Record<string, number> => {
  const times = helperNumber(n).costs;
  return {
    input_tokens: SPENT.input_tokens * times,
    cache_creation_input_tokens: SPENT.cache_creation_input_tokens * times,
    cache_read_input_tokens: SPENT.cache_read_input_tokens * times,
    output_tokens: SPENT.output_tokens * times,
  };
};

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
                input: {
                  subagent_type: 'general-purpose',
                  description: helperNumber(n).brief,
                  prompt: helperNumber(n).brief,
                },
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
                : { type: 'tool_result', tool_use_id: callOf(n), content: helperNumber(n).answer },
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
    const mine = helperNumber(n);
    const sidechain = (extra: Record<string, unknown>, seconds: number): Record<string, unknown> =>
      stamp({ isSidechain: true, agentId, ...extra }, seconds);
    // Each helper's rows carry ids of their own. A record's uuid is unique
    // across the whole chat — the reader keys a message by it — so three
    // helpers written from one template with one set of ids are not three
    // conversations: the second and third are read as the first one repeated,
    // and a pane opened on either drew no words at all (bw-t26l.20).
    const own = (step: number): string => `fixture-h${step}-${agentId}`;
    const helper = [
      sidechain(
        { parentUuid: null, uuid: own(1), type: 'user', message: { role: 'user', content: mine.brief } },
        3 + n,
      ),
      sidechain(
        {
          parentUuid: own(1),
          uuid: own(2),
          type: 'assistant',
          message: {
            id: `msg_${agentId}_h1`,
            model: mine.model,
            role: 'assistant',
            usage: spentBy(n),
            content: [{ type: 'text', text: mine.said }],
          },
        },
        8 + n,
      ),
      sidechain(
        {
          parentUuid: own(2),
          uuid: own(3),
          type: 'assistant',
          message: {
            id: `msg_${agentId}_h2`,
            model: mine.model,
            role: 'assistant',
            usage: spentBy(n),
            content: [
              { type: 'tool_use', id: `toolu_fixtureHelperRan${n}`, name: 'Bash', input: { command: `bd show ${card}` } },
            ],
          },
        },
        20 + n,
      ),
      sidechain(
        {
          parentUuid: own(3),
          uuid: own(4),
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
          parentUuid: own(4),
          uuid: own(5),
          type: 'assistant',
          message: {
            id: `msg_${agentId}_h3`,
            model: mine.model,
            role: 'assistant',
            usage: spentBy(n),
            content: [{ type: 'text', text: n === soured ? HELPER_FAILED : mine.answer }],
          },
        },
        // Its own clock: the row says how long THIS one took, and three rows
        // reading the same number prove nothing about any of them.
        3 + n + mine.seconds,
      ),
    ];
    writeFileSync(join(helpers, `agent-${agentId}.jsonl`), asLines(helper));
    writeFileSync(
      join(helpers, `agent-${agentId}.meta.json`),
      JSON.stringify({
        agentType: 'general-purpose',
        description: mine.brief,
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
  const sentAway = Array.from({ length: many }, (_, n) => helperNumber(n).costs * HELPER_TURNS * A_CALL).reduce(
    (sum, one) => sum + one,
    0,
  );
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

/**
 * One chat on disk, dated when it happened, and a way to speak into it again
 * while somebody is looking at the list.
 *
 * What a case about the DAYS over the list needs: a conversation whose clock is
 * yesterday's — both clocks, what he said in it and the file's own, because a
 * row is dated by whichever of the two the sidecar can read — and then one
 * message said into it this morning, from outside the app, exactly as a chat
 * resumed in a terminal is (bw-hgd2).
 */
export interface DatedChat {
  /** The conversation's own id, which is what a row is found by. */
  sessionId: string;
  /** The chat's own file. */
  path: string;
  /** What the row is named, so a case can read it off the screen. */
  name: string;
  /** He speaks in it again, now. The record grows; nothing is reloaded. */
  saysAgain(text?: string): void;
  /** And the agent answers him, which is the next thing to reach the record. */
  agentAnswers(text?: string): void;
  /** Everything written, so a run can take it away again. */
  remove: () => void;
}

export function writeChatSpokenAt(opts: {
  cwd: string;
  sessionId: string;
  /** When he last spoke in it, which is the clock the list runs on. */
  at: Date;
  /** What the row is called. Written as the kit writes a chat's own name. */
  name: string;
  branch?: string;
}): DatedChat {
  const { cwd, sessionId, at, name } = opts;
  const branch = opts.branch ?? 'main';
  const dir = join(configDir(), 'projects', projectSlug(cwd));
  const path = join(dir, `${sessionId}.jsonl`);
  mkdirSync(dir, { recursive: true });

  const said = (n: number, when: Date, extra: Record<string, unknown>): Record<string, unknown> => ({
    sessionId,
    cwd,
    gitBranch: branch,
    version: '2.1.237',
    userType: 'external',
    timestamp: when.toISOString(),
    parentUuid: n === 1 ? null : `dated-${sessionId}-u${n - 1}`,
    uuid: `dated-${sessionId}-u${n}`,
    ...extra,
  });

  const rows = [
    { type: 'ai-title', aiTitle: name },
    said(1, at, { type: 'user', message: { role: 'user', content: `${name}, said out loud so the row has words in it.` } }),
    said(2, new Date(at.getTime() + 2000), {
      type: 'assistant',
      message: {
        id: `msg_dated_${sessionId}`,
        model: 'claude-opus-5',
        role: 'assistant',
        usage: SPENT,
        content: [{ type: 'text', text: 'Noted.' }],
      },
    }),
  ];
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  // The file's own clock too: a row is dated by what he said in it where that
  // can be read, and by when the record last moved where it cannot.
  utimesSync(path, at, at);

  let more = 2;
  return {
    sessionId,
    path,
    name,
    saysAgain: (text = 'And one more thing this morning.'): void => {
      more += 1;
      appendFileSync(path, JSON.stringify(said(more, new Date(), { type: 'user', message: { role: 'user', content: text } })) + '\n');
    },
    agentAnswers: (text = 'On it.'): void => {
      more += 1;
      appendFileSync(
        path,
        JSON.stringify(
          said(more, new Date(), {
            type: 'assistant',
            message: {
              id: `msg_dated_${sessionId}_${more}`,
              model: 'claude-opus-5',
              role: 'assistant',
              usage: SPENT,
              content: [{ type: 'text', text }],
            },
          }),
        ) + '\n',
      );
    },
    remove: () => {
      rmSync(path, { force: true });
      rmSync(join(dir, sessionId), { recursive: true, force: true });
    },
  };
}

/**
 * A long conversation on disk, and a way to say more into it while it is read.
 *
 * What every case about scrolling needs and nothing else here writes: enough
 * messages that the pane is many screenfuls deep, each one findable by its own
 * number, and a record another program is still appending to — which is how a
 * row arrives under a reader who is looking somewhere else (bw-n6yh).
 */
export interface LongChat {
  /** The conversation's own id, which is what a row is found by. */
  sessionId: string;
  /** The chat's own file. */
  path: string;
  /** How many messages it opens with. */
  held: number;
  /** Somebody else says one more into it. Hands back what was said, to find it by. */
  says(text?: string): string;
  /** Everything written, so a run can take it away again. */
  remove: () => void;
}

/** How the nth message of a long chat reads. Numbered, so its place is readable. */
export function longChatSaid(n: number): string {
  return `Message ${n} of a long conversation, said so a scrolling case has something to find.`;
}

export function writeLongChat(opts: { cwd: string; sessionId: string; held?: number; branch?: string }): LongChat {
  const { cwd, sessionId } = opts;
  const held = opts.held ?? 120;
  const branch = opts.branch ?? 'main';
  const began = new Date(Date.now() - 60 * 60 * 1000);

  const dir = join(configDir(), 'projects', projectSlug(cwd));
  const path = join(dir, `${sessionId}.jsonl`);
  mkdirSync(dir, { recursive: true });

  let last: string | null = null;
  const line = (n: number, text: string, at: Date): Record<string, unknown> => {
    const uuid = `long-u${n}`;
    const parentUuid = last;
    last = uuid;
    const said =
      n % 2 === 0
        ? { type: 'user', message: { role: 'user', content: text } }
        : {
            type: 'assistant',
            message: {
              id: `msg_long_${n}`,
              model: 'claude-opus-5',
              role: 'assistant',
              usage: SPENT,
              content: [{ type: 'text', text }],
            },
          };
    return {
      sessionId,
      cwd,
      gitBranch: branch,
      version: '2.1.237',
      userType: 'external',
      timestamp: at.toISOString(),
      parentUuid,
      uuid,
      ...said,
    };
  };

  const rows: Record<string, unknown>[] = [];
  for (let n = 0; n < held; n += 1) rows.push(line(n, longChatSaid(n), new Date(began.getTime() + n * 1000)));
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  let more = held;
  return {
    sessionId,
    path,
    held,
    says: (text?: string): string => {
      const n = more++;
      const said = text ?? longChatSaid(n);
      appendFileSync(path, JSON.stringify(line(n, said, new Date())) + '\n');
      return said;
    },
    remove: () => {
      rmSync(path, { force: true });
      rmSync(join(dir, sessionId), { recursive: true, force: true });
    },
  };
}
