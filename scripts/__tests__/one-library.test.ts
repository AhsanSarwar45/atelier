/**
 * The one-library check has to keep naming hand-painted controls.
 *
 * Nothing about a screen painting its own button fails anywhere else — it
 * renders, it clicks, it just looks wrong beside the rest of the app. The whole
 * guard against that drift is scripts/one-library.py, so if that script stops
 * finding an offence, or stops being run, nothing else notices.
 *
 * These plant one screen per rule in a throwaway folder and read what the check
 * says about them, so the rules are proved on markup nobody is about to edit.
 * Delete the check and every case here goes red.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CHECK = resolve(__dirname, "..", "one-library.py");

let folder: string;

/** What the check says about a folder, plus whether it would fail a gate. */
function run(path: string) {
  const out = spawnSync("python3", [CHECK, path], { encoding: "utf8" });
  return { said: `${out.stdout}${out.stderr}`, failed: out.status !== 0 };
}

function screen(name: string, markup: string) {
  writeFileSync(join(folder, name), markup);
  return join(folder, name);
}

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "one-library-"));
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe("the one-library check", () => {
  it("is there to be run at all", () => {
    expect(existsSync(CHECK)).toBe(true);
  });

  it("names a button a screen painted itself", () => {
    const path = screen(
      "own-button.tsx",
      `export const A = () => <button className="rounded-md border bg-primary px-2">Go</button>;`,
    );
    const { said, failed } = run(path);
    expect(said).toContain("painted by hand");
    expect(said).toContain("<Button>");
    expect(failed).toBe(true);
  });

  it("leaves a click target that paints nothing alone", () => {
    const path = screen(
      "bare-button.tsx",
      `export const A = () => <button className="flex items-center gap-2" onClick={go}>Go</button>;`,
    );
    const { said, failed } = run(path);
    expect(said).toContain("0 hand-painted");
    expect(failed).toBe(false);
  });

  it("names the browser's own picker", () => {
    const path = screen(
      "picker.tsx",
      `export const A = () => <select value={v} onChange={set}><option>one</option></select>;`,
    );
    const { said } = run(path);
    expect(said).toContain("<Select>");
  });

  it("names a dimmed backdrop drawn by hand", () => {
    const path = screen(
      "backdrop.tsx",
      `export const A = () => <div className="fixed inset-0 z-50 bg-black/80" onClick={shut} />;`,
    );
    const { said } = run(path);
    expect(said).toContain("backdrop painted by hand");
  });

  it("names a card face drawn by hand, background or no background", () => {
    const path = screen(
      "face.tsx",
      `export const A = () => (
         <div className={cn("rounded-md border p-2", dragging && "opacity-50")}>x</div>
       );`,
    );
    const { said } = run(path);
    expect(said).toContain("card or panel face");
    expect(said).toContain("<Card>");
  });

  it("reads classes the screen builds up rather than spells out", () => {
    const path = screen(
      "built-up.tsx",
      `export const A = () => (
         <button
           className={cn(
             "inline-flex items-center",
             active ? "bg-accent" : "bg-transparent",
           )}
         >Go</button>
       );`,
    );
    const { said } = run(path);
    expect(said).toContain("painted by hand");
  });

  it("leaves the library itself alone, because that is where paint lives", () => {
    const library = join(folder, "components", "ui");
    mkdirSync(library, { recursive: true });
    writeFileSync(
      join(library, "button.tsx"),
      `export const Button = () => <button className="rounded-md border bg-primary" />;`,
    );
    const { said, failed } = run(library);
    expect(said).toContain("0 hand-painted");
    expect(failed).toBe(false);
  });

  it("says the offence's screen and line, so it can be gone to", () => {
    const path = screen(
      "placed.tsx",
      `const x = 1;\nconst y = 2;\nexport const A = () => <select />;`,
    );
    const { said } = run(path);
    expect(said).toMatch(/placed\.tsx:3: /);
  });
});
