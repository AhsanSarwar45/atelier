/**
 * Every colour a state asks for has to survive the build.
 *
 * Tailwind emits a class only if it read the file that spells it, so the state
 * colours went grey the moment they moved out of a scanned folder — the board
 * kept exactly one, the one another component happened to spell by hand.
 * Reading the source and reasoning about it is what missed that, so this runs
 * the real thing: Tailwind, over the real tree, with the shipped config, and
 * asks whether the class came out the far end.
 */
import postcss from "postcss";
import tailwind from "tailwindcss";
import { describe, expect, it } from "vitest";

import { getStatusDotColor } from "@/lib/bead-utils";
import { classesFor } from "@/lib/state-styles";
import { STATES } from "@/types";

import config from "../../../tailwind.config";

/** The class names in one tone's set, split out of the strings the app hands to Tailwind. */
function classesOf(status: string): string[] {
  const set = classesFor(status as never);
  return [set.text, set.borderTop, set.badge]
    .join(" ")
    .split(/\s+/)
    .filter((c) => c.includes("status-"));
}

/** A class as it appears in the stylesheet: an opacity's slash and a variant's colon are escaped. */
function selector(cls: string): string {
  return "." + cls.replace(/[/:]/g, (c) => "\\" + c);
}

/** The utilities the shipped config produces over the real source tree. */
async function build(): Promise<string> {
  const out = await postcss([tailwind(config)]).process("@tailwind utilities;", {
    from: undefined,
  });
  return out.css;
}

describe("state colours reach the stylesheet", () => {
  it("builds every class every state asks for", async () => {
    const css = await build();
    const missing = STATES.flatMap((s) => classesOf(s.id))
      .filter((c) => !css.includes(selector(c)));
    expect(missing).toEqual([]);
  }, 60_000);

  it("builds the dot beside every piece listed under a card", async () => {
    // The columns and the dots went grey together; they read the same file, so
    // the dot is asked for by the name the card list actually calls.
    const css = await build();
    const missing = STATES.map((s) => getStatusDotColor(s.id))
      .filter((c) => !css.includes(selector(c)));
    expect(missing).toEqual([]);
  }, 60_000);

  it("goes red when the source holding them is out of reach", async () => {
    // The fault this test exists for: the config naming folders rather than all
    // of src, with the colours living outside them.
    const narrowed = {
      ...config,
      content: ["./src/app/**/*.{js,ts,jsx,tsx,mdx}"],
    };
    const out = await postcss([tailwind(narrowed)]).process("@tailwind utilities;", {
      from: undefined,
    });
    const missing = STATES.flatMap((s) => classesOf(s.id))
      .filter((c) => !out.css.includes(selector(c)));
    expect(missing.length).toBeGreaterThan(0);
  }, 60_000);
});
