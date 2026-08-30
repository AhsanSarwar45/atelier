/**
 * One list decides the states.
 *
 * The failure this guards is silent: a menu, a switch or a colour table that
 * hand-copies the state names keeps working, and keeps offering exactly the
 * states it was born with, while the board grows two more. That is what the
 * manager saw — six columns on the board and four entries in the menu.
 *
 * So the rule is not "the list is complete", which nobody can check. It is
 * "nothing else lists them": every file that names two or more states in a row
 * has to be reading STATES instead.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  NO_COUNTS, SET_BY, STATES, STATE_BY_ID, counted, finished, standing,
  type BeadStatus,
} from "@/types";

const ROOT = join(__dirname, "../../..");

/** The file that is allowed to spell the states out. */
const THE_LIST = "src/types/index.ts";

/**
 * The server, which cannot import a TypeScript list. Its copy is held to the
 * list by `the server knows every state` below instead of being trusted.
 */
const THE_SERVER = "server/src/routes/beads.rs";

/**
 * Files that name states for a reason other than listing them: the parser maps
 * what bd sends onto them, and the styles are keyed by tone with the type
 * forcing them complete.
 */
const ALLOWED = new Set([
  "src/lib/beads-parser.ts",
  "src/lib/state-styles.ts",
  THE_SERVER,
  // Native hooks cannot import the browser list and must recognize the board
  // transitions they protect even when no frontend is present.
  "server/src/lifecycle.rs",
]);

const NAMES = STATES.map((s) => s.id);

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(ROOT, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|rs)$/.test(entry.name)) found.push(path.replaceAll("\\", "/"));
    }
  };
  walk("src");
  walk("server/src");
  return found;
}

/** The code of a file: no comments, and for Rust none of its own test module. */
function codeOf(path: string): string[] {
  let text = readFileSync(join(ROOT, path), "utf8");
  if (path.endsWith(".rs")) {
    const tests = text.indexOf("#[cfg(test)]");
    if (tests !== -1) text = text.slice(0, tests);
  }
  return text
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, ""));
}

/**
 * A copy of the list, as opposed to a file that asks about one state: three or
 * more state names inside six lines. A menu, a switch or an array always
 * clusters like that; `status === "closed"` in two far-apart functions does not.
 */
function listsStates(lines: string[]): string[] {
  const WINDOW = 6;
  const hit = (l: string) => NAMES.filter((n) => new RegExp(`['"\`]${n}['"\`]`).test(l));
  for (let i = 0; i < lines.length; i++) {
    const seen = new Set<string>();
    for (let j = i; j < Math.min(i + WINDOW, lines.length); j++) {
      for (const n of hit(lines[j])) seen.add(n);
    }
    if (seen.size >= 3) return Array.from(seen);
  }
  return [];
}

describe("one list decides the states", () => {
  it("every state has a label, a column, a colour, an icon and a key", () => {
    for (const s of STATES) {
      expect(s.label, `${s.id} needs a label`).toBeTruthy();
      expect(s.column, `${s.id} needs a column heading`).toBeTruthy();
      expect(s.tone, `${s.id} needs a colour`).toBeTruthy();
      expect(s.icon, `${s.id} needs an icon`).toBeTruthy();
      expect(s.key, `${s.id} needs a keyboard key`).toBeTruthy();
    }
  });

  it("no two states share a keyboard key", () => {
    const keys: string[] = STATES.map((s) => s.key);
    expect(new Set(keys).size, `duplicate key in ${keys.join(", ")}`).toBe(keys.length);
  });

  it("no two states share a column heading or a name on screen", () => {
    // Two columns with one heading is a board nobody can read, and the screen
    // gives no hint which of them a card fell into.
    for (const field of ["column", "label"] as const) {
      const seen: string[] = STATES.map((s) => s[field]);
      expect(new Set(seen).size, `two states share a ${field}: ${seen.join(", ")}`)
        .toBe(seen.length);
    }
  });

  it("every state says what writing it means", () => {
    for (const s of STATES) {
      expect(SET_BY[s.id], `${s.id} has no entry in SET_BY`).toBeTruthy();
      expect(SET_BY[s.id].status, `${s.id} must write some status`).toBeTruthy();
      // A mark one state writes is not a mark the next one carries: work that
      // was dropped and then genuinely finished must not still read as dropped.
      if (s.id !== 'cancelled') {
        expect(SET_BY[s.id].removeLabel, `${s.id} leaves the cancelled mark on`)
          .toBe('cancelled');
      }
    }
  });

  it("every state says whether a piece in it is part of the job", () => {
    // Asserted against what the board IS, not against the same expression the
    // readings are written from — restating the implementation gives a case
    // that cannot go red whatever the list says.
    for (const s of STATES) {
      expect(typeof s.counts, `${s.id} does not say whether it counts`).toBe("boolean");
    }

    // Work still standing is always part of the job: dropping is something
    // done to work, and a state cannot mean both at once.
    const live = STATES.filter((s) => s.live).map((s) => s.id);
    expect(live.filter((id) => !counted(id)), "a live state that counts for nothing")
      .toEqual([]);
    expect(live.filter((id) => !standing(id)), "a live state nobody is waiting on")
      .toEqual([]);

    // One state is finished work and one means dropped, and they are the two
    // that are not live. A seventh of either is a board nobody can count.
    expect(STATES.filter((s) => finished(s.id)).map((s) => s.id)).toEqual(["closed"]);
    expect(STATES.filter((s) => !s.live && !s.counts).map((s) => s.id)).toEqual(["cancelled"]);
  });

  it("exactly one state means the work was dropped", () => {
    const dropped = STATES.filter((s) => !s.counts).map((s) => s.id);
    expect(dropped).toEqual(["cancelled"]);
  });

  it("the counts carry one number per state", () => {
    expect(Object.keys(NO_COUNTS()).sort()).toEqual([...NAMES].sort());
  });

  it("the lookup answers for every state", () => {
    for (const s of STATES) expect(STATE_BY_ID[s.id as BeadStatus]).toBe(s);
  });

  it("no other file lists the states", () => {
    const guilty: string[] = [];
    for (const path of sourceFiles()) {
      if (path === THE_LIST || ALLOWED.has(path) || path.includes("__tests__")) continue;
      const copied = listsStates(codeOf(path));
      if (copied.length) guilty.push(`${path} (${copied.join(", ")})`);
    }
    expect(guilty, `these files carry their own list of states instead of reading `
      + `STATES from ${THE_LIST}`).toEqual([]);
  });

  it("the server knows every state", () => {
    // It cannot import the list, so what it can do is fail when it falls behind.
    const code = codeOf(THE_SERVER).join("\n");
    const missing = NAMES.filter((n) => !new RegExp(`"${n}"`).test(code));
    expect(missing, `${THE_SERVER} counts beads state by state and has never heard `
      + `of ${missing.join(", ")}, so those beads are dropped from the counts`).toEqual([]);
  });
});
