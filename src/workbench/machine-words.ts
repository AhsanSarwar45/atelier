/**
 * What every message the kit can send actually SAYS, and who it is for.
 *
 * The complaint this answers is the manager's, 2026-08-21, about a line drawn
 * in his own half of a chat: "Allowance: the seven-day window is
 * allowed_warning until 12:00 PM" — "this message and others like it are not
 * for me… it makes no sense for a human. go through all statuses and actually
 * read them, and then properly categorise them."
 *
 * Two faults, and they are different faults.
 *
 * The first is the wording. A line like that is built by dropping the kit's own
 * word for a state into an English sentence, which is how `allowed_warning`,
 * `PreToolUse`, `error_max_turns` and `sticky` all reached his screen. Nobody
 * decided to show him those words; each one is simply what was to hand where a
 * sentence needed a verb. So every state the kit declares is written out here
 * in English, once, and the driver has no other way to name one.
 *
 * The second is who each line is for. The screen used to work that out from the
 * kind plus its loudness, and loudness is two values — so an allowance that was
 * merely getting full and an allowance that had actually stopped his work were
 * the same thing to it, and both landed in front of him. The state is the thing
 * that decides, the driver is the only part of the app that has it, so the
 * audience is settled HERE, at the state, and rides on the note
 * (docs/agent-workbench.md §8.2.4).
 *
 * Every state below is copied from the kit's own type file — the enums in
 * `sdk.d.ts`, not from memory — and `scripts/chat-shows-what-is-yours.mjs`
 * re-reads that file on every run and fails when the kit has grown a kind or a
 * state this table does not name. That is what stops the table from being a
 * snapshot of one afternoon's reading.
 *
 * Nothing is imported here at run time, so the check can read the real table
 * and drive the real driver rather than keeping a copy of either
 * (`machine-lines.ts` is the same bargain).
 */
import type { Audience } from './protocol';

/** One state of one kind: what it reads as, and whose business it is. */
export interface StateWord {
  /**
   * The English the driver puts in the sentence for this state.
   *
   * `null` where the message carries its own human wording — an
   * `informational` banner, a notification's text — and the state decides only
   * how loud it is and who it is for.
   */
  said: string | null;
  /** Who a line in this state is for. */
  who: Audience;
}

/** Every state one kind can be in, and how to put a message into one. */
export interface KindWords {
  /** Where on the kit's message the state is read from. Prose, for the reader. */
  from: string;
  /**
   * Where the kit DECLARES these states, so the check can hold this table to
   * the type file instead of to whoever last read it: the name of the type in
   * `sdk.d.ts` and the property inside it. `null` where the kit declares no
   * enum at all and the states below are this app's own reading of the message.
   */
  kit: { type: string; field: string } | null;
  /**
   * States this table adds that the kit has no word for, and why each one is
   * real. Anything here is exempt from the check that every state comes from
   * the type file — which is the point of having to write the reason down.
   */
  ours: Record<string, string>;
  /**
   * A message of this kind in that state, as the kit would shape it.
   *
   * The check builds one of these per state and puts it through the real
   * driver, so the sentence it grades is the sentence the chat draws rather
   * than a restatement of this table (bw-iiv6).
   */
  sample: (state: string) => Record<string, unknown>;
  states: Record<string, StateWord>;
}

/** The window an allowance is measured over, in words a reader owns. */
export const ALLOWANCE_WINDOW: Record<string, string> = {
  five_hour: 'five-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
  seven_day_overage_included: 'weekly, extra usage included',
  overage: 'extra usage',
};

/**
 * When a rule of his runs. The kit's `hook_event` is an open string, so this is
 * every moment it declares today and an unnamed one simply goes unsaid rather
 * than printing itself.
 */
export const HOOK_MOMENT: Record<string, string> = {
  PreToolUse: 'before a tool runs',
  PostToolUse: 'after a tool ran',
  PostToolUseFailure: 'after a tool failed',
  PostToolBatch: 'after a batch of tools ran',
  Notification: 'when a notice goes up',
  UserPromptSubmit: 'when you send a message',
  UserPromptExpansion: 'while your message is being expanded',
  SessionStart: 'when the chat opens',
  SessionEnd: 'when the chat closes',
  Stop: 'when the turn ends',
  StopFailure: 'when a turn ends badly',
  SubagentStart: 'when a sent-off agent starts',
  SubagentStop: 'when a sent-off agent ends',
  PreCompact: 'before the chat folds itself up',
  PostCompact: 'after the chat folded itself up',
  PermissionRequest: 'when something asks permission',
  PermissionDenied: 'when something is refused',
  Setup: 'at setup',
  TeammateIdle: 'when a teammate goes idle',
  TaskCreated: 'when a piece of work is created',
  TaskCompleted: 'when a piece of work finishes',
  Elicitation: 'when an add-on asks you something',
  ElicitationResult: 'when you answer an add-on',
  ConfigChange: 'when a setting changes',
  WorktreeCreate: 'when a working copy is cut',
  WorktreeRemove: 'when a working copy is removed',
  InstructionsLoaded: 'when instructions are loaded',
  CwdChanged: 'when the working folder changes',
  FileChanged: 'when a file changes',
  DirectoryAdded: 'when a folder is added',
  MessageDisplay: 'when a message is drawn',
};

/**
 * How a turn ended, on the chip that says what the chat is doing.
 *
 * The chip used to wear the kit's own subtype — `error_max_turns` sat where
 * "Ready" sits, in the one place on the screen a reader looks to know whether
 * he can type (bw-iiv6).
 */
export const TURN_ENDED: Record<string, string> = {
  success: 'Ready',
  error_during_execution: 'Failed',
  error_max_turns: 'Hit the turn limit',
  error_max_budget_usd: 'Hit the spending limit',
  error_max_structured_output_retries: 'Could not answer in the shape asked for',
};

/**
 * How much a chat asks before it does things, in words rather than in settings.
 *
 * The line announcing a change said `bypassPermissions` — the setting's own
 * spelling — and so did every option in the picker beside it. Thirty-seven of
 * those lines are in the manager's record, all of them drawn to him, and it is
 * the one line here that MUST be read: a chat that has quietly stopped asking
 * before it runs things is a trap (§8.2.4). `said` finishes "This chat will
 * now…"; `label` names the setting on the picker.
 */
export const PERMISSION_MODE: Record<string, { label: string; said: string }> = {
  default: { label: 'Ask first', said: 'ask before anything risky' },
  acceptEdits: { label: 'Edit freely', said: 'change files without asking' },
  plan: { label: 'Plan only', said: 'plan only, and change nothing' },
  dontAsk: { label: 'Do not ask', said: 'stop asking about tools' },
  auto: { label: 'Automatic', said: 'decide for itself' },
  bypassPermissions: { label: 'Skip all checks', said: 'skip every permission check' },
};

/**
 * A word off the wire, made readable, for the one case nothing better exists.
 *
 * The kit invents settings and states between our releases, and the choice then
 * is between printing `bypassPermissions` at a reader and printing nothing at
 * all. This is the third way: the same word with its seams opened up. It is a
 * fallback and never a substitute for writing the sentence — everything the kit
 * declares today is written out above by hand.
 */
export function inWords(wire: string): string {
  const opened = wire
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return opened ? opened[0].toUpperCase() + opened.slice(1) : wire;
}

const machine = (said: string | null): StateWord => ({ said, who: 'machine' });
const his = (said: string | null): StateWord => ({ said, who: 'you' });

/**
 * Every kind that has states, every state it can be in, and both answers.
 *
 * A kind with no states of its own is not here: its sentence never varies, so
 * there is nothing to read out of the message, and its audience is settled once
 * in `machine-lines.ts`. What IS here is every place the driver used to reach
 * for the wire's word because the message had more than one thing it could
 * mean.
 */
export const WORDS: Record<string, KindWords> = {
  /**
   * His allowance.
   *
   * A window that is fine, and a window filling up, are both the machine
   * keeping its books: the token gauge already draws exactly this, continuously
   * and in one place, and a grey line repeating it every few minutes is
   * something he can do nothing about (bw-3ug7, and the manager's own words
   * above). A window that has actually turned work away is the reason his work
   * stopped, so that one is his and says the time it comes back.
   */
  rate_limit_event: {
    from: 'rate_limit_info.status, and errorCode when it says credits are needed',
    kit: { type: 'SDKRateLimitInfo', field: 'status' },
    ours: {
      credits_required: 'the kit puts this on errorCode, beside a rejected status, not on status itself',
    },
    sample: (state) => ({
      type: 'rate_limit_event',
      rate_limit_info:
        state === 'credits_required'
          ? { status: 'rejected', errorCode: 'credits_required', rateLimitType: 'seven_day' }
          : { status: state, rateLimitType: 'seven_day', resetsAt: 1_700_000_000 },
    }),
    states: {
      allowed: machine('is fine'),
      allowed_warning: machine('is running low'),
      rejected: his('has run out'),
      credits_required: his('has run out, and buying credits is the way on'),
    },
  },

  /**
   * The chat's own state, and the answer to a fold-up he asked for.
   *
   * `requesting` fires on every single request and `compacting` while the work
   * happens; both are the machine breathing. The answer to /compact is the one
   * thing here he asked a question and is owed an answer to.
   */
  'system/status': {
    from: 'status, and compact_result when a fold-up has just finished',
    kit: { type: 'SDKStatusMessage', field: 'status' },
    ours: {
      idle: 'the kit writes a null status; nothing is happening',
      compacted: 'the answer to a fold-up he asked for, which the kit puts on compact_result',
      compact_failed: 'the same answer when it did not work',
    },
    sample: (state) =>
      state === 'compacted'
        ? { type: 'system', subtype: 'status', compact_result: 'success' }
        : state === 'compact_failed'
          ? { type: 'system', subtype: 'status', compact_result: 'failed', compact_error: 'the summary would not fit' }
          : { type: 'system', subtype: 'status', status: state === 'idle' ? null : state },
    states: {
      requesting: machine('Asking the model'),
      compacting: machine('Folding this chat up to make room'),
      idle: machine('Sitting idle'),
      compacted: his('Compacted this chat.'),
      compact_failed: his('Could not compact this chat'),
    },
  },

  /** Why the chat folded itself up. Either way it changes what the agent knows. */
  'system/compact_boundary': {
    from: 'compact_metadata.trigger',
    kit: { type: 'SDKCompactBoundaryMessage', field: 'trigger' },
    ours: {},
    sample: (state) => ({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: state, pre_tokens: 120000, post_tokens: 30000 },
    }),
    states: {
      manual: his('You asked this chat to fold itself up'),
      auto: his('This chat filled up and folded itself up'),
    },
  },

  /**
   * A rule of his finishing. All three outcomes are the machine's: a rule that
   * REFUSED a turn does not arrive here — it arrives as a refusal of its own,
   * under its own kind, and that one is his.
   */
  'system/hook_response': {
    from: 'outcome',
    kit: { type: 'SDKHookResponseMessage', field: 'outcome' },
    ours: {},
    sample: (state) => ({
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'tidy-up',
      hook_event: 'PreToolUse',
      outcome: state,
      output: '',
      stdout: '',
      stderr: '',
    }),
    states: {
      success: machine('ran'),
      error: machine('could not run'),
      cancelled: machine('was called off'),
    },
  },

  /** An add-on being put in. Nothing here is his unless it would not go in. */
  'system/plugin_install': {
    from: 'status',
    kit: { type: 'SDKPluginInstallMessage', field: 'status' },
    ours: {},
    sample: (state) => ({ type: 'system', subtype: 'plugin_install', status: state, name: 'an add-on' }),
    states: {
      started: machine('is being installed'),
      installed: machine('is installed'),
      completed: machine('finished installing'),
      failed: machine('could not be installed'),
    },
  },

  /**
   * A sent-off agent coming home.
   *
   * The panel is the list of agents, so the chat says nothing about one unless
   * it FAILED — the manager's ruling of 2026-08-20. One he stopped himself is
   * not news to him either.
   */
  'system/task_notification': {
    from: 'status',
    kit: { type: 'SDKTaskNotificationMessage', field: 'status' },
    ours: {},
    sample: (state) => ({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'a-task',
      status: state,
      summary: 'what it did',
      output_file: '',
    }),
    states: {
      completed: machine('finished'),
      failed: his('failed'),
      stopped: machine('was stopped'),
    },
  },

  /** A sent-off agent's row changing. All of it is drawn on the row itself. */
  'system/task_updated': {
    from: 'patch.status',
    kit: { type: 'SDKTaskUpdatedMessage', field: 'status' },
    ours: {},
    sample: (state) => ({ type: 'system', subtype: 'task_updated', task_id: 'a-task', patch: { status: state } }),
    states: {
      pending: machine('is waiting to start'),
      running: machine('is running'),
      paused: machine('is parked'),
      completed: machine('has finished'),
      failed: machine('failed'),
      killed: machine('was stopped'),
    },
  },

  /** The model would not answer, and what was done about it. */
  'system/model_refusal_fallback': {
    from: 'direction',
    kit: { type: 'SDKModelRefusalFallbackMessage', field: 'direction' },
    ours: {},
    sample: (state) => ({
      type: 'system',
      subtype: 'model_refusal_fallback',
      direction: state,
      original_model: 'the model you picked',
      fallback_model: 'another model',
    }),
    states: {
      retry: his('so the same question went to'),
      revert: his('so the chat went back to'),
      sticky: his('so the rest of this chat is answered by'),
    },
  },

  /**
   * A banner the loop wrote. It carries its own human wording, so the level
   * decides only how loudly it is drawn.
   */
  'system/informational': {
    from: 'level',
    kit: { type: 'SDKInformationalMessage', field: 'level' },
    ours: {},
    sample: (state) => ({ type: 'system', subtype: 'informational', level: state, content: 'something worth saying' }),
    states: {
      info: machine(null),
      notice: machine(null),
      suggestion: machine(null),
      warning: machine(null),
    },
  },

  /** A notice. Its own wording again; the priority decides only the loudness. */
  'system/notification': {
    from: 'priority',
    kit: { type: 'SDKNotificationMessage', field: 'priority' },
    ours: {},
    sample: (state) => ({ type: 'system', subtype: 'notification', priority: state, key: 'k', text: 'something to know' }),
    states: {
      low: machine(null),
      medium: machine(null),
      high: machine(null),
      immediate: machine(null),
    },
  },

  /** How memories were found. Both ways are the chat furnishing itself. */
  'system/memory_recall': {
    from: 'mode',
    kit: { type: 'SDKMemoryRecallMessage', field: 'mode' },
    ours: {},
    sample: (state) => ({ type: 'system', subtype: 'memory_recall', mode: state, memories: [{ path: '/a/memory.md', scope: 'personal' }] }),
    states: {
      select: machine('Recalled'),
      synthesize: machine('Recalled'),
    },
  },

  /**
   * The chat changing state under him.
   *
   * Idle and working are the machine's own business — the chat's own chip says
   * both, continuously. One that is WAITING on him is his: nothing moves until
   * he answers, and nothing else on the screen says so.
   */
  'system/session_state_changed': {
    from: 'state',
    kit: { type: 'SDKSessionStateChangedMessage', field: 'state' },
    ours: {},
    sample: (state) => ({ type: 'system', subtype: 'session_state_changed', state }),
    states: {
      idle: machine('This chat is idle.'),
      running: machine('This chat is working.'),
      requires_action: his('This chat is waiting on you.'),
    },
  },

  /** How a request the app made is getting on. Its own plumbing, start to end. */
  'system/control_request_progress': {
    from: 'status',
    kit: { type: 'SDKControlRequestProgressMessage', field: 'status' },
    ours: {},
    sample: (state) => ({ type: 'system', subtype: 'control_request_progress', request_id: 'r', status: state }),
    states: {
      started: machine('The app asked the agent to do something.'),
      api_retry: machine('The app is asking the agent again after the service was busy.'),
    },
  },

  /**
   * Files he attached being put away. Only a failure is his — a file that did
   * not arrive is a file the agent will not see, and he is the one who can
   * send it again.
   */
  'system/files_persisted': {
    from: 'whether anything is in failed',
    kit: null,
    ours: {
      stored: 'the kit declares no state here; a message with an empty failed list is one where everything arrived',
      some_failed: 'the same message with anything in its failed list',
    },
    sample: (state) => ({
      type: 'system',
      subtype: 'files_persisted',
      files: state === 'stored' ? [{ filename: 'a.png', file_id: '1' }] : [],
      failed: state === 'stored' ? [] : [{ filename: 'a.png', error: 'too large' }],
      processed_at: '',
    }),
    states: {
      stored: machine('Stored'),
      some_failed: his('Could not store'),
    },
  },
};

/** Every kind this table has states for, for the check that reads the kit. */
export const KINDS_WITH_STATES: string[] = Object.keys(WORDS);

/**
 * Every kind the driver deliberately draws no line for, and why.
 *
 * A kind is either worded here or silent on purpose. What is NOT allowed is a
 * kind nobody has thought about, because that one prints its own wire name into
 * the middle of a conversation, which is the fault this job is about.
 */
export const SAID_NOTHING: Record<string, string> = {
  'system/local_command_output': 'the command answers in the chat itself, as an ordinary reply',
  'system/thinking_tokens': 'an estimate twice a second, drawn as the thinking counter',
  'system/commands_changed': 'the list of commands, drawn as the list of commands',
  prompt_suggestion: 'a guess at what he might type next; it belongs in the writing box, never in the record',
};

/**
 * What to call one of his own rules, with the kit's naming taken off it.
 *
 * The kit names a rule by the moment it runs at and what it matches —
 * `PreToolUse:Bash`, `SessionStart:startup`, or just `Stop` — so "Your
 * PreToolUse:Bash rule is running" hands him the wire's word for the moment
 * twice: once inside the name and once again in the English after it. The
 * moment is already said in English at the end of the line, so what is worth
 * keeping is only the half that says WHICH rule (bw-iiv6.9).
 */
export function ruleCalled(name: string): string | null {
  const [moment, matches] = name.split(':');
  const left = moment !== undefined && moment in HOOK_MOMENT ? matches : name;
  return left === undefined || left.length === 0 ? null : left;
}

/**
 * The whole of "Your Bash rule is running, before a tool runs."
 *
 * Both the live line and the restatement of an old one are made here, for the
 * same reason the allowance line's ending is: two makers drift, and the drift
 * is a wire word coming back on the older half (bw-iiv6.9).
 */
export function ruleIsRunning(name: string, moment: string): string {
  const when = HOOK_MOMENT[moment];
  return `Your ${ruleCalled(name) ?? 'own'} rule is running${when ? `, ${when}` : ''}.`;
}

/** The same, for a rule that has finished: "Your startup rule ran." */
export function ruleFinished(name: string, said: string, trouble: string): string {
  return `Your ${ruleCalled(name) ?? 'own'} rule ${said}${trouble ? `: ${trouble}` : ''}.`;
}

/**
 * How an allowance line ends, which is the whole of its tone.
 *
 * The time means two different things on the two sides: to him it is when his
 * work starts again, to the machine's own books it is when a counter turns
 * over. The live driver had this rule and the restatement of an old line did
 * not, so a frozen line saying the work had been turned away came back reading
 * like routine bookkeeping — the same look-alike the job exists to remove
 * (bw-iiv6.11). One rule, in one place, used by both.
 */
export function whenItComesBack(who: Audience, back: string | null): string {
  if (back === null) return '.';
  return who === 'you' ? ` — nothing more runs until ${back}.` : ` (it renews at ${back}).`;
}

/** What one state of one kind reads as, or null when the message brings its own words. */
export function saidOf(kind: string, state: string): string | null {
  return WORDS[kind]?.states[state]?.said ?? null;
}

/**
 * Who a line in this exact state is for, or null when this build has never met
 * the state.
 *
 * Null rather than a guess: the caller falls back to the ruling for the whole
 * kind, and the check turns a null into a failure, so a state the kit adds is
 * caught here instead of quietly landing in front of him.
 */
export function whoFor(kind: string, state: string): Audience | null {
  return WORDS[kind]?.states[state]?.who ?? null;
}

/**
 * What the kit says in the CHAT'S OWN VOICE, rather than as a message about it.
 *
 * The manager, 2026-08-21, on "You've hit your session limit · resets 3:50pm
 * (Asia/Karachi)" drawn as an ordinary grey paragraph: "this you hit your
 * session limit, which is the actual status that matters, shows as regular
 * message". He is right, and it is a different fault from the one above.
 *
 * Everything in `WORDS` arrives as a message ABOUT the run — a kind, a state,
 * a shape the driver can read. These arrive as the run's own answer: the kit
 * opens an assistant message, writes one sentence, and closes it. There is no
 * kind on it and no state beside it, so every rule this file makes is looking
 * at the other door, and the one line in the whole app that means nothing more
 * will happen until 3:50pm draws exactly like a sentence about code.
 *
 * The sentence itself is the only reliable signal. The status that ought to
 * carry it appears once in the manager's entire record against forty of these,
 * so waiting for the tidy one means the fault stays on his screen.
 *
 * Not guessed at: the kit declares four lists of these openings in `sdk.d.ts`
 * — under `USAGE_LIMIT_ERROR_PREFIXES` and its three neighbours — for exactly
 * this, telling a consumer to "route these to org-disabled presentation, never
 * the usage-limit card". This app is a consumer and routed none of them. The
 * check re-reads those lists on every run, so an opening a new kit version
 * adds fails here rather than landing in front of him unsorted.
 *
 * The kit's own sentences are QUOTED, never rewritten. They are already
 * written for a person, and they carry a time, a number or a link this app
 * cannot regenerate — and a rewrite would drift a little further from the
 * truth with every kit release. What this table decides is not the words, it
 * is what the line MEANS and who it is for.
 */
export interface SpokenWords {
  /** What this app files the sentence under once it is recognised. */
  kind: string;
  /**
   * The list in `sdk.d.ts` these openings are copied from, so the check holds
   * the table to the kit's own file. `null` where the kit declares no list and
   * the opening below is this app's own reading of the manager's record.
   */
  kit: string | null;
  /** What a line opening this way means. Prose, for whoever reads this next. */
  means: string;
  /**
   * How the line opens. Only the opening: the rest is the time it comes back,
   * the number it stands at, or the place to add funds — all of which move.
   */
  opens: string[];
}

export const KIT_SPEAKS: SpokenWords[] = [
  {
    kind: 'kit/limit_reached',
    kit: 'USAGE_LIMIT_ERROR_PREFIXES',
    means: 'nothing more runs on this chat until the window comes back, or until it is paid for',
    opens: [
      "You've hit your",
      "You've reached your",
      "You're out of usage credits",
      'Your org is out of usage · add funds to continue',
      'Your org is out of usage · contact your admin',
      "Your seat type doesn't include usage credits",
      "Your seat type doesn't include usage",
      'Your usage allocation has been disabled by your admin',
      "Your group's usage limit is set to $0",
      'Fable 5 requires usage credits',
      "You're out of extra usage",
      "Your seat type doesn't include extra usage",
    ],
  },
  {
    kind: 'kit/org_blocked',
    kit: 'ORG_POLICY_LIMIT_PREFIXES',
    means: 'the same standstill, but it is a rule rather than a spent allowance, so waiting will not clear it',
    opens: ['This service is disabled for your org'],
  },
  {
    kind: 'kit/limit_near',
    kit: 'USAGE_WARNING_PREFIXES',
    means: 'a window filling up. Nothing has stopped, so it is the machine keeping its books — the same ruling the allowance messages get',
    opens: ["You've used", "You're close to"],
  },
  {
    kind: 'kit/paying_differently',
    kit: 'USAGE_TRANSITION_PREFIXES',
    means: 'the allowance is spent and the work is now being paid for by the token. Nothing stops, but what it costs him changes, and he can stop it or switch models',
    opens: [
      "You're now using usage credits",
      "You're now using your usage allocation",
      'Now using your usage allocation',
      'Now using usage credits',
      "You're now using extra usage",
      'Now using extra usage',
    ],
  },
  {
    kind: 'kit/service_failed',
    kit: null,
    means: 'the turn died on the service rather than on anything he asked for. Six of these in his record, all of them drawn as ordinary answers',
    opens: ['API Error'],
  },
  {
    kind: 'kit/no_answer_wanted',
    kit: null,
    means: 'the chat was handed something nobody wanted a reply to. Eleven in his record, and none of them worth a line of his attention',
    opens: ['No response requested.'],
  },
];

/**
 * The longest one of the kit's own lines runs, and the guard against mistaking
 * a real answer for one.
 *
 * Every one of the 91 in the manager's record is a single line, and the longest
 * is 147 characters. An answer that opens the same way — a paragraph about what
 * a limit is — runs on, wraps, or is one of several; requiring one short line
 * costs a false positive nothing and a real answer nothing at all.
 */
const SPOKEN_AT_MOST = 240;

/**
 * The kind a line of the chat's own text belongs to, or null when it is the
 * chat actually answering him.
 */
export function kitSpoke(text: string): string | null {
  const line = text.trim();
  if (line.length === 0 || line.length > SPOKEN_AT_MOST || line.includes('\n')) return null;
  for (const spoken of KIT_SPEAKS) {
    if (spoken.opens.some((opening) => line.startsWith(opening))) return spoken.kind;
  }
  return null;
}

/** Every kind the kit speaks in its own voice, for the check and the tests. */
export const SPOKEN_KINDS: string[] = KIT_SPEAKS.map((spoken) => spoken.kind);
