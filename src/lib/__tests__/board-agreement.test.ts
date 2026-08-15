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

import { columnFor, drawnInColumns, oldestFirst } from "@/lib/bead-utils";
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

  it("a gate is the board's own lock and is never drawn as work", () => {
    const gate = { id: "gate-1", status: "open", issue_type: "gate" };
    const drawn = drawnInColumns([goal, gate]).map((b) => b.id);
    expect(drawn).toEqual(["g"]);
  });
});

describe("a card sits where its own pieces put it", () => {
  type Node = { id: string; status: string; children?: string[] };
  const board = (...nodes: Node[]) => new Map(nodes.map((n) => [n.id, n]));

  it("every piece untouched leaves the card in the first column", () => {
    const goal = { id: "g", status: "open", children: ["s1", "s2"] };
    const map = board(goal, { id: "s1", status: "open" }, { id: "s2", status: "open" });
    expect(columnFor(goal, map)).toBe("open");
  });

  it("one piece being worked is enough to say the card is being worked", () => {
    // The goal keeps its stored status until the board moves it, so its own
    // status alone would leave every started job sitting in the first column.
    const goal = { id: "g", status: "open", children: ["s1", "s2"] };
    const map = board(goal, { id: "s1", status: "closed" }, { id: "s2", status: "in_progress" });
    expect(columnFor(goal, map)).toBe("in_progress");
  });

  it("a piece waiting to be read never speaks for the card it is under", () => {
    // What the manager caught: a job drawn under Agent Review with everything
    // under it untouched. Only the board puts a card in that column, and only
    // once no piece is left standing.
    const goal = { id: "g", status: "open", children: ["s1", "s2"] };
    const map = board(goal, { id: "s1", status: "inreview" }, { id: "s2", status: "open" });
    expect(columnFor(goal, map)).toBe("open");
  });

  it("a piece two levels down is its own job's business, not this card's", () => {
    // Read one level and one level only: a card and the list of pieces printed
    // beneath it can then never contradict each other.
    const goal = { id: "g", status: "open", children: ["s1"] };
    const map = board(goal,
      { id: "s1", status: "open", children: ["w1"] },
      { id: "w1", status: "in_progress" });
    expect(columnFor(goal, map)).toBe("open");
  });

  it("a review column is the board's own answer and is left alone", () => {
    const goal = { id: "g", status: "inreview", children: ["s1"] };
    expect(columnFor(goal, board(goal, { id: "s1", status: "closed" }))).toBe("inreview");
  });

  it("the manager's column outranks anything still open below it", () => {
    const goal = { id: "g", status: "manager_review", children: ["s1"] };
    expect(columnFor(goal, board(goal, { id: "s1", status: "open" }))).toBe("manager_review");
  });

  it("a card the board still holds open is not drawn as finished", () => {
    const goal = { id: "g", status: "open", children: ["s1", "s2"] };
    const map = board(goal, { id: "s1", status: "closed" }, { id: "s2", status: "cancelled" });
    expect(columnFor(goal, map)).toBe("open");
  });

  it("a card being worked with nothing left standing is still being worked", () => {
    const goal = { id: "g", status: "in_progress", children: ["s1"] };
    expect(columnFor(goal, board(goal, { id: "s1", status: "closed" }))).toBe("in_progress");
  });

  it("a closed goal stays closed once its pieces are done", () => {
    const goal = { id: "g", status: "closed", children: ["s1"] };
    expect(columnFor(goal, board(goal, { id: "s1", status: "closed" }))).toBe("closed");
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

/**
 * The manager's column is the one nobody else can empty, so the card that has
 * waited longest is the one he sees first. On the running screen this is read
 * back by scripts/board-columns-agree.py, which needs two cards to be waiting
 * before it can say anything.
 */
describe("the manager's column is the oldest first", () => {
  const ids = (cards: { id: string }[]) => cards.map((c) => c.id);

  it("the card that has waited longest is at the top", () => {
    const cards = [
      { id: "new", created_at: "2026-08-13T09:00:00Z" },
      { id: "old", created_at: "2026-08-01T09:00:00Z" },
      { id: "middle", created_at: "2026-08-07T09:00:00Z" },
    ];
    expect(ids(oldestFirst(cards))).toEqual(["old", "middle", "new"]);
  });

  it("two cards opened in the same second keep the order they came in", () => {
    const cards = [
      { id: "first", created_at: "2026-08-01T09:00:00Z" },
      { id: "second", created_at: "2026-08-01T09:00:00Z" },
    ];
    expect(ids(oldestFirst(cards))).toEqual(["first", "second"]);
  });

  it("a card that cannot say when it opened does not claim to be the oldest", () => {
    const cards = [
      { id: "undated" },
      { id: "old", created_at: "2026-08-01T09:00:00Z" },
    ];
    expect(ids(oldestFirst(cards))).toEqual(["old", "undated"]);
  });

  it("the column it was given is not reordered underneath it", () => {
    const cards = [
      { id: "new", created_at: "2026-08-13T09:00:00Z" },
      { id: "old", created_at: "2026-08-01T09:00:00Z" },
    ];
    oldestFirst(cards);
    expect(ids(cards)).toEqual(["new", "old"]);
  });
});
