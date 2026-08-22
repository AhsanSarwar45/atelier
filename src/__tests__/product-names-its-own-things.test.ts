/**
 * The product calls its own things by its own names.
 *
 * Atelier is a board for work tracked with beads, and for a long while it said
 * so everywhere: the dashboard offered to "Manage Your Beads Projects", the
 * filter bar counted "2 beads have unknown statuses", the new-card dialog was
 * headed "New Bead". A reader was told, on every screen, that they were
 * looking at somebody else's product (bw-1mei).
 *
 * The names the code carries are a separate matter and deliberately left
 * alone: `Bead`, `beadId` and `BeadStatus` mirror what bd's own records are
 * called, and nobody using the app ever reads them. What this checks is the
 * words that reach a reader.
 *
 * Two things keep their spelling because they are not our things to rename:
 * the credit link to the tracker itself, and the literal `.beads` folder that
 * bd writes on disk. Both are listed below by hand, so adding a third is a
 * decision somebody has to write down rather than a check quietly widening.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const SCREENS = join(__dirname, "..");

/** The tracker's name where it is the tracker's to keep. */
const THEIRS = [
  "Beads CLI", // the credit link on the dashboard footer
];

/**
 * Every screen source, tests aside — those talk about the code, not to a
 * reader.
 */
function sources(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "__tests__" && name !== "node_modules") sources(path, found);
    } else if (/\.tsx?$/.test(name)) {
      found.push(path);
    }
  }
  return found;
}

/**
 * What is left of a file once the parts no reader ever sees are gone:
 * comments, and the expressions inside a template string — `${bead.title}` is
 * a value being read, not a word being said.
 */
function whatIsSaid(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\$\{[^{}]*\}/g, " ");
}

/**
 * The tracker's name used as a word, rather than as part of one. A property
 * read (`bead.status`), a path (`/links/bead/:id`), a folder (`.beads`) and a
 * package (`beads-web`) all spell it, and none of them is the app talking.
 */
const AS_A_WORD = /(?<![\w.$/\-])beads?(?![\w.[(/\-])/i;

/** Anything with a space in it is prose; anything without is a name. */
function readerFacing(said: string): string[] {
  const found: string[] = [];
  const quoted = /'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`|>([^<>{}]*)</g;
  // Walked with the pattern's own cursor rather than as a list of matches: the
  // build this repository typechecks under cannot step through one.
  let m: RegExpExecArray | null;
  while ((m = quoted.exec(said)) !== null) {
    const s = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").trim();
    // Text sitting between two angle brackets is drawn text — unless the two
    // brackets belong to a generic, in which case what is between them is
    // code. Code punctuation is what tells them apart.
    if (m[4] !== undefined && /[;(){}[\]=]/.test(s)) continue;
    if (!s.includes(" ") || s.startsWith("http")) continue;
    if (!AS_A_WORD.test(s)) continue;
    found.push(s.replace(/\s+/g, " "));
  }
  return found;
}

describe("the words a reader meets are the product's own", () => {
  it("names the tracker only where the tracker is being credited", () => {
    const said: string[] = [];
    for (const path of sources(SCREENS)) {
      for (const line of readerFacing(whatIsSaid(readFileSync(path, "utf8")))) {
        if (THEIRS.includes(line)) continue;
        said.push(`${relative(SCREENS, path)}: ${line}`);
      }
    }
    expect(said, `${said.length} thing(s) the reader is shown still call this `
      + `product's own work by the tracker's name`).toEqual([]);
  });

  it("would notice one going back in", () => {
    const put = whatIsSaid(`<h1>Manage Your Beads Projects</h1>`);
    expect(readerFacing(put)).toEqual(["Manage Your Beads Projects"]);
  });

  it("leaves the names the code carries alone", () => {
    const code = whatIsSaid("const beadId = bead.id; type X = BeadStatus;");
    expect(readerFacing(code)).toEqual([]);
  });
});
