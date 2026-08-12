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

import { columnFor, drawnInColumns } from "@/lib/bead-utils";
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

describe("the columns draw one card per job", () => {
  const goal = { id: "g", status: "open" };
  const step = (status: string) => ({ id: `s-${status}`, status, parent_id: "g" });

  it("a step is not a card of its own, whatever it is doing", () => {
    const drawn = drawnInColumns([goal, step("in_progress"), step("open")]).map((b) => b.id);
    expect(drawn).toEqual(["g"]);
  });
});

describe("a card sits in the column of the work under it", () => {
  type Node = { id: string; status: string; children?: string[] };
  const board = (...nodes: Node[]) => new Map(nodes.map((n) => [n.id, n]));

  it("a goal whose step is claimed is in progress, not open", () => {
    // The shape that produced the report: the goal stays `open` on the board
    // until its last step closes, so its own status never says it is moving.
    const goal = { id: "g", status: "open", children: ["s1", "s2"] };
    const map = board(goal, { id: "s1", status: "closed" }, { id: "s2", status: "in_progress" });
    expect(columnFor(goal, map)).toBe("in_progress");
  });

  it("a goal whose remaining work is waiting to land is in review", () => {
    const goal = { id: "g", status: "open", children: ["s1", "s2"] };
    const map = board(goal, { id: "s1", status: "closed" }, { id: "s2", status: "inreview" });
    expect(columnFor(goal, map)).toBe("inreview");
  });

  it("work being done wins over work waiting to land", () => {
    const goal = { id: "g", status: "open", children: ["s1", "s2"] };
    const map = board(goal, { id: "s1", status: "inreview" }, { id: "s2", status: "in_progress" });
    expect(columnFor(goal, map)).toBe("in_progress");
  });

  it("a card being worked itself outranks work below it waiting to land", () => {
    // The card's own status is live work too, so it enters the same ranking as
    // its children instead of only being the fallback nobody looks at.
    const card = { id: "g", status: "in_progress", children: ["s1"] };
    expect(columnFor(card, board(card, { id: "s1", status: "inreview" }))).toBe("in_progress");
  });

  it("a goal nobody has started keeps its own status", () => {
    const goal = { id: "g", status: "open", children: ["s1"] };
    expect(columnFor(goal, board(goal, { id: "s1", status: "open" }))).toBe("open");
  });

  it("a closed goal stays closed once its steps are done", () => {
    const goal = { id: "g", status: "closed", children: ["s1"] };
    expect(columnFor(goal, board(goal, { id: "s1", status: "closed" }))).toBe("closed");
  });

  it("work two levels down still pulls the goal along", () => {
    // `job under` hangs the real work below a step, so the live card is a
    // grandchild of the goal and a single level of lookup would miss it.
    const goal = { id: "g", status: "open", children: ["s1"] };
    const map = board(goal,
      { id: "s1", status: "open", children: ["w1"] },
      { id: "w1", status: "in_progress" });
    expect(columnFor(goal, map)).toBe("in_progress");
  });

  it("a card with nothing under it keeps its own status", () => {
    const lone = { id: "t", status: "in_progress" };
    expect(columnFor(lone, board(lone))).toBe("in_progress");
  });

  it("a loop in the graph does not hang the screen", () => {
    const a = { id: "a", status: "open", children: ["b"] };
    const b = { id: "b", status: "open", children: ["a"] };
    expect(columnFor(a, board(a, b))).toBe("open");
  });
});
