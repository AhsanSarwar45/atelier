import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * A right-click on the tree opens its menu where the pointer is (bw-5gax.1).
 *
 * The owner reported the menu opening far below the row it was asked about. The
 * cause was not the coordinates — those were the pointer's own — but what they
 * were read against: the Files rail carries a transform at every width
 * (`-translate-x-full` when shut, `translate-x-0` when open), which makes the
 * rail and not the viewport the containing block for the `position: fixed`
 * anchor the menu hangs off. Measured before the fix, at 1440×900: a press at
 * y=219 opened its menu at y=307 — the rail's own top edge, 96px, added to
 * every press.
 *
 * So what this proves is a coordinate frame, not a look: the menu's own box
 * against the point the mouse was actually at, and the row the menu says it is
 * about against the row that was under the pointer. It is measured at a desktop
 * width and a phone width, and with the tree SCROLLED — the rows are virtualised
 * with `translateY`, which is the case a coordinate-space mistake hides in.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/the-tree-menu-opens-at-the-pointer.spec.ts
 */

const SHOTS = 'tests/results';
const WAIT = 60_000;

/**
 * How far the menu's top-left may sit from the press once it has settled, in
 * CSS px.
 *
 * Small but not zero: the library is allowed to nudge a menu off an edge. It is
 * measured after [`SETTLED`], because the menu slides in from 8px above where
 * it is going and a box read mid-slide is a reading of the animation. The fault
 * this guards against was 96px.
 */
const NEAR = 2;

/** How long the library's open animation takes to put the menu down, in ms. */
const SETTLED = 400;

function git(at: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: at, stdio: 'pipe' });
}

/** Enough files that the tree really scrolls, which is half of what is proved. */
function seed(where: string): void {
  rmSync(where, { recursive: true, force: true });
  mkdirSync(join(where, 'src'), { recursive: true });
  writeFileSync(join(where, 'README.md'), '# readme\n');
  for (let at = 0; at < 80; at += 1) {
    writeFileSync(join(where, 'src', `file-${String(at).padStart(2, '0')}.ts`), `export const n = ${at};\n`);
  }
  git(where, 'init', '-q', '-b', 'main', '.');
  git(where, 'config', 'user.name', 'Atelier Tester');
  git(where, 'config', 'user.email', 'tester@atelier.test');
  git(where, 'config', 'commit.gpgsign', 'false');
  git(where, 'add', '-A');
  git(where, 'commit', '-qm', 'seed');
}

async function fixtureProject(request: APIRequestContext, name: string, path: string) {
  const made = await request.post('/api/projects', { data: { name, path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

async function seeTestProjects(page: Page): Promise<void> {
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
}

test('a right-click opens the tree menu at the pointer, at every width and scrolled', async ({ page, request }) => {
  test.setTimeout(180_000);
  const fixture = join(__dirname, '..', '.workbench-run-5gax-menu');
  seed(fixture);
  await seeTestProjects(page);
  const project = await fixtureProject(request, 'tree-menu-at-pointer', fixture);
  const menu = page.getByTestId('files-tree-menu');
  const rows = page.locator('[data-testid="files-tree-row"]');

  /**
   * The nth row a reader can actually see, which is not `rows.nth(n)`: the
   * virtualiser keeps a dozen rows mounted outside the pane, and their boxes
   * are above it or below it. Picking one of those and pressing at its box is
   * pressing somewhere else entirely.
   */
  const visible = async (nth: number) => {
    const pane = (await page.getByTestId('files-tree-scroller').boundingBox())!;
    const many = await rows.count();
    let seen = 0;
    for (let at = 0; at < many; at += 1) {
      const box = await rows.nth(at).boundingBox();
      if (!box) continue;
      if (box.y < pane.y || box.y + box.height > pane.y + pane.height) continue;
      if (seen === nth) return { row: rows.nth(at), box };
      seen += 1;
    }
    throw new Error(`the tree does not show ${nth + 1} whole rows`);
  };

  /**
   * Right-click the nth row a reader can see and report where the menu landed
   * against where the mouse was — and which row the menu believes it is about.
   */
  const pressed = async (nth: number, called: string) => {
    await expect(menu).toBeHidden();
    const { row, box } = await visible(nth);
    const wanted = await row.getAttribute('data-path');
    const at = { x: Math.round(box.x + 40), y: Math.round(box.y + box.height / 2) };
    await page.mouse.move(at.x, at.y);
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await menu.waitFor({ timeout: WAIT });
    await page.waitForTimeout(SETTLED);
    const drawn = (await menu.boundingBox())!;
    const off = { dx: drawn.x - at.x, dy: drawn.y - at.y };
    console.log(`${called}: press ${JSON.stringify(at)} → menu ${JSON.stringify({ x: drawn.x, y: drawn.y })} (dx=${off.dx} dy=${off.dy})`);
    // The menu is about the row the mouse was over, not the row a stale
    // coordinate would have hit: the virtualiser's `translateY` is the thing
    // that would make those two differ.
    expect(await menu.getAttribute('data-path'), `${called}: the menu is about another row`).toBe(wanted);
    expect(Math.abs(off.dx), `${called}: the menu is ${off.dx}px sideways of the press`).toBeLessThanOrEqual(NEAR);
    expect(Math.abs(off.dy), `${called}: the menu is ${off.dy}px below the press`).toBeLessThanOrEqual(NEAR);
    return off;
  };

  const dismiss = async () => {
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden({ timeout: WAIT });
    // The library's own close animation holds the layer that swallows the next
    // press; a second right-click sent into it never reaches a row.
    await page.waitForTimeout(400);
  };

  try {
    mkdirSync(SHOTS, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/project?id=${project.id}&tab=files`);
    await page.getByTestId('files-tree').waitFor({ timeout: WAIT });
    await expect(page.getByTestId('files-tab')).toHaveAttribute('data-root', fixture, { timeout: WAIT });
    await page.locator(`[data-testid="files-tree-row"][data-path="${fixture}/src"]`).click();
    await expect(rows).not.toHaveCount(2, { timeout: WAIT });

    // ── A wide screen, tree at the top ────────────────────────────────────
    await pressed(1, 'desktop');
    await page.screenshot({ path: `${SHOTS}/bw-5gax1-after-desktop.png`, animations: 'disabled' });
    await dismiss();

    // ── A wide screen, tree scrolled ──────────────────────────────────────
    await page.getByTestId('files-tree-scroller').evaluate((pane: Element) => { pane.scrollTop = 400; });
    await page.waitForTimeout(300);
    await pressed(4, 'desktop scrolled');
    await page.screenshot({ path: `${SHOTS}/bw-5gax1-after-desktop-scrolled.png`, animations: 'disabled' });
    await dismiss();
    await page.getByTestId('files-tree-scroller').evaluate((pane: Element) => { pane.scrollTop = 0; });

    // ── A phone, the rail open over the viewer ────────────────────────────
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    const toggle = page.getByTestId('files-rail-toggle');
    if ((await page.getByTestId('files-rail').getAttribute('data-open')) !== 'true') await toggle.click();
    await expect(page.getByTestId('files-rail')).toHaveAttribute('data-open', 'true', { timeout: WAIT });
    // The sheet slides in; a press sent at it mid-slide is a press at a moving row.
    await page.waitForTimeout(600);
    await pressed(2, 'phone rail open');
    await page.screenshot({ path: `${SHOTS}/bw-5gax1-after-phone.png`, animations: 'disabled' });
    await dismiss();

    // ── A phone, scrolled ─────────────────────────────────────────────────
    await page.getByTestId('files-tree-scroller').evaluate((pane: Element) => { pane.scrollTop = 400; });
    await page.waitForTimeout(300);
    await pressed(5, 'phone scrolled');
    await page.screenshot({ path: `${SHOTS}/bw-5gax1-after-phone-scrolled.png`, animations: 'disabled' });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true });
  }
});
