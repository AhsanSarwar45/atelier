/**
 * The screen has to be able to draw everything the board holds.
 *
 * Two ways it stopped being able to, both of which looked like an empty board
 * rather than a bug: a status bd writes that the screen had no column for, and
 * a filter that kept every child out of the columns while every claimed card is
 * a child. Neither shows up as a failure anywhere — the screen just reads zero.
 *
 * The end-to-end check is scripts/board-columns-agree.py, which needs a browser
 * and a running server. These are the parts that can go red on their own.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { drawnInColumns } from "@/lib/bead-utils";
import { STATUS_MAP } from "@/types";

/**
 * The statuses bd ships with, asked of bd itself rather than copied here: an
 * invalid one makes it name the whole set. The question only has an answer
 * inside a board, so this asks a throwaway one. Returns null when bd is absent.
 *
 * A project may add its own on top (corsetta's `in_review` is one), and those
 * are the end-to-end script's business — it asks the board it is pointed at.
 */
function statusesBdShipsWith(): string[] | null {
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "bd-status-probe-"));
    execFileSync("bd", ["init", "--prefix", "probe"], { cwd: dir, stdio: "ignore" });
    try {
      execFileSync("bd", ["list", "--status", "definitely-not-a-status"], {
        cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      return null; // it accepted nonsense; the probe no longer means anything
    } catch (e) {
      const said = String((e as { stderr?: string }).stderr ?? (e as Error).message);
      const listed = /valid:\s*([^)]+)\)/.exec(said);
      return listed ? listed[1].split(",").map((s) => s.trim()).filter(Boolean) : null;
    }
  } catch {
    return null; // no bd on this machine
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

describe("every status the board can hold has a column", () => {
  const shipped = statusesBdShipsWith();

  it.skipIf(shipped === null)("bd's own list is covered by STATUS_MAP", () => {
    const missing = (shipped ?? []).filter((s) => !(s in STATUS_MAP));
    expect(missing, `bd can set ${missing.join(", ")}, and the screen would file `
      + `${missing.length === 1 ? "it" : "them"} under Open with a warning badge`).toEqual([]);
  });

  it("in_review reaches the review column", () => {
    // The screen has always called this column `inreview`; bd writes `in_review`.
    expect(STATUS_MAP.in_review).toEqual({ column: "inreview" });
  });
});

describe("the columns draw the work that is under way", () => {
  const goal = { id: "g", status: "open" };
  const step = (status: string) => ({ id: `s-${status}`, status, parent_id: "g" });

  it("a step being worked is a card of its own", () => {
    const drawn = drawnInColumns([goal, step("in_progress")]).map((b) => b.id);
    expect(drawn).toContain("s-in_progress");
  });

  it("a step waiting to land is a card of its own", () => {
    const drawn = drawnInColumns([goal, step("inreview")]).map((b) => b.id);
    expect(drawn).toContain("s-inreview");
  });

  it("a step nobody has started stays inside its goal", () => {
    const drawn = drawnInColumns([goal, step("open")]).map((b) => b.id);
    expect(drawn).toEqual(["g"]);
  });

  it("a finished step stays inside the goal it finished", () => {
    const drawn = drawnInColumns([goal, step("closed")]).map((b) => b.id);
    expect(drawn).toEqual(["g"]);
  });

  it("a board of nothing but steps still fills In Progress", () => {
    // The shape that produced the report: every claimed card is a child.
    const board = [goal, step("open"), step("in_progress"), step("closed")];
    const inProgress = drawnInColumns(board).filter((b) => b.status === "in_progress");
    expect(inProgress).toHaveLength(1);
  });
});
