/** Provider-neutral reading of Codex's final plan envelope. */
const PLAN = /<proposed_plan>[\t ]*\r?\n([\s\S]*?)\r?\n<\/proposed_plan>/g;

export interface ProposedPlanSpec {
  markdown: string;
  start: number;
  end: number;
}

export function proposedPlanSpecs(text: string): ProposedPlanSpec[] {
  const found: ProposedPlanSpec[] = [];
  const blocks = new RegExp(PLAN.source, PLAN.flags);
  let match: RegExpExecArray | null;
  while ((match = blocks.exec(text)) !== null) {
    const markdown = match[1]!.trim();
    if (markdown) found.push({ markdown, start: match.index, end: blocks.lastIndex });
  }
  return found;
}

/** Valid envelopes become cards; malformed ones remain readable Markdown. */
export function withoutProposedPlans(text: string): string {
  const stripped = text.replace(PLAN, '').trim();
  if (!stripped.includes('<proposed_plan>')) return stripped;
  return stripped.replace(/<\/?proposed_plan>/g, (tag) => `\`${tag}\``);
}
