import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const POLICY = readFileSync(resolve(__dirname, "..", "..", "machinery", "skills", "beads", "SKILL.md"), "utf8");

describe("the agent workflow check", () => {
  it("keeps the managed instructions on one repository command path", () => {
    for (const command of [
      "atelier tool board/job new", "git -C . worktree add worktrees/WORK-ID -b WORK-ID",
      "bd update WORK-ID --claim", "atelier tool board/land CARD-ID", "atelier tool checks CHECKS-ID",
    ]) expect(POLICY.split(command)).toHaveLength(2);
    expect(POLICY).toContain("Ticket-writing preferences are guidance, not gates");
  });
});
