import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const POLICY = readFileSync(resolve(__dirname, "..", "..", "machinery", "skills", "beads", "SKILL.md"), "utf8");

// Landing past unrelated failures is the same board/land command with one flag,
// not a second path, so that single spelling is set aside before counting.
const ONE_PATH = POLICY.replace("atelier tool board/land CARD-ID --checks-unrelated 'REASON'", "");

describe("the agent workflow check", () => {
  it("keeps the managed instructions on one repository command path", () => {
    for (const command of [
      "atelier tool board/job new", "git -C . worktree add worktrees/JOB-ID -b JOB-ID",
      "bd update JOB-ID.1 --claim", "atelier tool board/land CARD-ID", "atelier tool checks CARD-ID",
    ]) expect(ONE_PATH.split(command)).toHaveLength(2);
    expect(POLICY).toContain("Ticket-writing preferences are guidance, not gates");
  });
});
