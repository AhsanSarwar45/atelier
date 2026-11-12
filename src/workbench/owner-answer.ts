/**
 * The owner's answers, as the chat's agent is told them.
 *
 * When the owner approves or reopens a task, answers its plan change or a
 * proposal, or answers a grid's draft, N/A request or template change, the
 * server sends the chat's agent a message in the owner's place (docs/tasks.md,
 * "Proposals"; docs/grids.md). It is written for the agent ("Owner approved
 * task #3 …. Its commits are on main already …"), so drawn as the owner's own
 * message it reads as if he had typed it. These are told apart by the fixed
 * words the server starts them with (server/src/workbench/tasks/mod.rs
 * `owner_prompt` and `answer_prompt`, grids/mod.rs), and drawn as a short
 * line in his words instead: "You approved #3".
 */

/** One answer: the short line, and what the agent was told in full. */
export interface OwnerAnswer {
  line: string;
  full: string;
}

const TASK = String.raw`task #(\d+) "([\s\S]*?)"`;

/** Each shape the server writes, and the line it is drawn as. */
const SHAPES: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [new RegExp(String.raw`^Owner approved the plan change for ${TASK}:`), (m) => `You approved the plan change for #${m[1]}`],
  [new RegExp(String.raw`^Owner rejected the plan change for ${TASK}: continue with the old plan\.$`), (m) => `You rejected the plan change for #${m[1]}`],
  [new RegExp(String.raw`^Owner rejected the plan change for ${TASK}: ([\s\S]*?) Continue with the old plan\.$`), (m) => `You rejected the plan change for #${m[1]}: ${m[3]}`],
  [new RegExp(String.raw`^Owner approved ${TASK}\. `), (m) => `You approved #${m[1]}`],
  [new RegExp(String.raw`^Owner reopened ${TASK}(?:\.|: ([\s\S]*?)) (?:Start it again with |Continue the work and run done again\.)`),
    (m) => (m[3] ? `You reopened #${m[1]}: ${m[3]}` : `You reopened #${m[1]}`)],
  [/^Owner chose Create task for proposal "([\s\S]*?)": task #(\d+) created\./, (m) => `You created task #${m[2]} from the proposal`],
  [/^Owner chose Just do it for proposal "([\s\S]*?)":/, (m) => `You chose Just do it for “${m[1]}”`],
  [/^Owner chose Cancel for proposal "([\s\S]*?)":/, (m) => `You cancelled the proposal “${m[1]}”`],
  [/^Owner approved the edit to grid "([^"]+)"/, (m) => `You approved the edit to grid ${m[1]}`],
  [/^Owner approved grid "([^"]+)"/, (m) => `You approved grid ${m[1]}`],
  [/^Owner discarded the (draft of|edit to) grid "([^"]+)"/, (m) => `You discarded the ${m[1]} grid ${m[2]}`],
  [/^Owner approved N\/A for (\S+?);/, (m) => `You approved N/A for ${m[1]}`],
  [/^Owner rejected N\/A for (\S+?):/, (m) => `You rejected N/A for ${m[1]}`],
  [/^Owner approved the change to template "([^"]+)"/, (m) => `You approved the change to template ${m[1]}`],
  [/^Owner rejected the change to template "([^"]+)"/, (m) => `You rejected the change to template ${m[1]}`],
];

/** One answer's line, or null when the words are not one the server writes. */
export function ownerAnswer(text: string): OwnerAnswer | null {
  const full = text.trim();
  if (!full.startsWith('Owner ')) return null;
  for (const [shape, line] of SHAPES) {
    const m = full.match(shape);
    if (m) return { line: line(m), full };
  }
  return null;
}

/**
 * A message's answers, one per answer it carries, or null when it is not
 * wholly made of them. Answers held while the agent was busy may reach it
 * together, one to a paragraph.
 */
export function ownerAnswers(text: string): OwnerAnswer[] | null {
  const parts = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;
  const answers = parts.map(ownerAnswer);
  return answers.every((a): a is OwnerAnswer => a !== null) ? answers : null;
}
