/**
 * Every colour a state asks for has to survive the build.
 *
 * Tailwind emits a class only if it read the file that spells it, so the state
 * colours went grey the moment they moved out of a scanned folder.
 * Reading the source and reasoning about it is what missed that, so this runs
 * the real thing: Tailwind, over the real tree, with the shipped config, and
 * asks whether the class came out the far end.
 */
import postcss from "postcss";
import tailwind from "tailwindcss";
import { describe, expect, it } from "vitest";

import { classesFor, TONE_NAMES, type Tone } from "@/lib/state-styles";

import config from "../../../tailwind.config";

/** The class names in one tone's set, split out of the strings the app hands to Tailwind. */
function classesOf(tone: Tone): string[] {
  const set = classesFor(tone);
  return [set.text, set.badge]
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
  it("builds every class every tone asks for", async () => {
    const css = await build();
    const missing = TONE_NAMES.flatMap(classesOf)
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
    const missing = TONE_NAMES.flatMap(classesOf)
      .filter((c) => !out.css.includes(selector(c)));
    expect(missing.length).toBeGreaterThan(0);
  }, 60_000);
});
