import { describe, it, expect, vi, beforeEach } from "vitest";

import { STATES } from "@/types";

const command = vi.fn();
vi.mock("../api", () => ({ bd: { command: (...args: unknown[]) => command(...args) } }));

import { updateStatus } from "../cli"; // eslint-disable-line import/first

beforeEach(() => {
  command.mockReset();
  command.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
});

describe("a column a person asks for", () => {
  it("is written with --force, for every column the board offers", async () => {
    for (const state of STATES) {
      command.mockClear();
      await updateStatus("bw-1", state.id, "/a/project");
      const [args] = command.mock.calls[0] as [string[]];
      expect(args, state.id).toContain("--force");
    }
  });

  it("carries the force past the id, so bd reads it as a flag", async () => {
    await updateStatus("bw-1", "closed", "/a/project");
    const [args] = command.mock.calls[0] as [string[]];
    expect(args.slice(0, 2)).toEqual(["update", "bw-1"]);
    expect(args).toEqual(expect.arrayContaining(["--status", "closed", "--force"]));
  });
});
