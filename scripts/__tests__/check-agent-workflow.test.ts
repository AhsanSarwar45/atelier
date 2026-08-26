import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const CHECK = resolve(__dirname, "..", "check-agent-workflow.py");

describe("the agent workflow check", () => {
  it("keeps the managed instructions on one repository command path", () => {
    const run = spawnSync("python3", [CHECK], { encoding: "utf8" });

    expect(`${run.stdout}${run.stderr}`).toContain("agent workflow: 0 failures");
    expect(run.status).toBe(0);
  });
});
