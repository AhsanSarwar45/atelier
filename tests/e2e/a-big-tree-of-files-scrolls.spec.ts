import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The file tree, in a real browser, on a folder big enough to hurt (bw-g3o3.12).
 *
 * Five thousand entries in one directory is an ordinary thing — a `node_modules`
 * or a folder of generated pages — and it is the size at which a tree that draws
 * every row stops being usable: the tab takes a second to open and then stutters
 * on every flick of the wheel. So what is proved here is the thing a unit test
 * cannot see: that only a screenful of rows is ever in the page, that the
 * scrollbar is nonetheless the height of the whole folder, and that scrolling
 * through it produces no long frame.
 *
 * The rest of what is on screen is proved here too, because it is only true in a
 * browser: the material icons arriving as static SVGs, a folder opening on one
 * read, git's colours on the names, and the arrow keys walking the rows.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-big-tree-of-files-scrolls.spec.ts
 */

const SHOTS = 'tests/results';
const FIXTURE = join(__dirname, '..', '.workbench-run-big-tree');
const WAIT = 60_000;

/** How many files are put in the one big folder. */
const MANY = 5_000;

/** The longest single frame a scroll is allowed to take, in ms. */
const LONGEST_FRAME = 120;

test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });

function git(at: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: at, stdio: 'pipe' });
}

async function fixtureProject(request: APIRequestContext, path: string): Promise<{ id: string }> {
  const made = await request.post('/api/projects', { data: { name: 'big-tree', path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string };
}

/** Every row the tree currently has in the page, top to bottom. */
function rows(page: Page) {
  return page.getByTestId('files-tree-row');
}

/**
 * A checkout with one enormous folder, a few nested ones, and a spread of file
 * types that the icon table has an answer for.
 */
function build(): void {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(FIXTURE, 'many'), { recursive: true });
  for (let index = 0; index < MANY; index += 1) {
    writeFileSync(join(FIXTURE, 'many', `page-${String(index).padStart(5, '0')}.ts`), `export const n = ${index};\n`);
  }
  mkdirSync(join(FIXTURE, 'src', 'lib'), { recursive: true });
  writeFileSync(join(FIXTURE, 'src', 'main.ts'), 'export const main = 1;\n');
  writeFileSync(join(FIXTURE, 'src', 'styles.css'), 'body { color: red }\n');
  writeFileSync(join(FIXTURE, 'src', 'lib', 'deep.ts'), 'export const deep = 1;\n');
  writeFileSync(join(FIXTURE, 'Dockerfile'), 'FROM scratch\n');
  writeFileSync(join(FIXTURE, 'package.json'), '{"name":"big-tree"}\n');
  writeFileSync(join(FIXTURE, 'settings.json'), '{"a":1}\n');
  writeFileSync(join(FIXTURE, 'README.md'), '# big tree\n');
  writeFileSync(join(FIXTURE, 'notes.wibble'), 'nothing knows this ending\n');
  // What git ignores is still listed by the server, flagged, so the tree can dim
  // it — and a folder nobody asked to see is exactly what the toggle is for.
  writeFileSync(join(FIXTURE, '.gitignore'), 'build/\n');
  mkdirSync(join(FIXTURE, 'build'), { recursive: true });
  writeFileSync(join(FIXTURE, 'build', 'out.js'), 'console.log(1)\n');

  git(FIXTURE, 'init', '-q', '-b', 'main', '.');
  git(FIXTURE, 'config', 'user.name', 'Atelier Tester');
  git(FIXTURE, 'config', 'user.email', 'tester@atelier.test');
  git(FIXTURE, 'config', 'commit.gpgsign', 'false');
  git(FIXTURE, 'add', '-A');
  git(FIXTURE, 'commit', '-qm', 'seed');

  // Three states git can be in, so three colours are on screen at once.
  writeFileSync(join(FIXTURE, 'README.md'), '# big tree, edited\n');
  writeFileSync(join(FIXTURE, 'brand-new.py'), 'print(1)\n');
  writeFileSync(join(FIXTURE, 'picked.rs'), 'fn main() {}\n');
  git(FIXTURE, 'add', 'picked.rs');
}

test('a folder of five thousand files opens, scrolls smoothly, and is drawn a screenful at a time', async ({
  page,
  request,
}) => {
  build();
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  const project = await fixtureProject(request, FIXTURE);

  try {
    mkdirSync(SHOTS, { recursive: true });
    await page.goto(`/project?id=${project.id}&tab=files`);
    await page.getByTestId('files-tree').waitFor({ timeout: WAIT });
    await expect.poll(() => rows(page).count(), { timeout: WAIT }).toBeGreaterThan(5);

    // The material icons are real files on the server, not glyphs drawn from
    // the bundle, and the names they were chosen by are the file's own.
    const iconOf = async (path: string) =>
      page.locator(`[data-testid="files-tree-row"][data-path="${FIXTURE}/${path}"] [data-icon]`).getAttribute('data-icon');
    expect(await iconOf('Dockerfile')).toBe('docker');
    expect(await iconOf('package.json')).toBe('nodejs');
    expect(await iconOf('settings.json')).toBe('json');
    expect(await iconOf('src')).toBe('folder-src');
    // Nothing in the pruned table matches, so the app's own outline stands in.
    expect(await iconOf('notes.wibble')).toBe('lucide');
    const svg = await page.request.get('/file-icons/docker.svg');
    expect(svg.status(), 'the copied SVGs are not being served').toBe(200);
    expect(await svg.text()).toContain('<svg');

    // Git's word about a file is the colour of its name, in the Git rail's own
    // palette (STATUS_LOOK).
    const named = (path: string) => page.locator(`[data-testid="files-tree-row"][data-path="${FIXTURE}/${path}"]`);
    await expect.poll(() => named('README.md').getAttribute('data-status'), { timeout: WAIT }).toBe('modified');
    expect(await named('README.md').locator('.text-warning').count()).toBe(1);
    expect(await named('picked.rs').getAttribute('data-status')).toBe('added');
    expect(await named('brand-new.py').getAttribute('data-status')).toBe('untracked');

    // Ignored is dimmed, and the toggle takes it away and brings it back.
    await expect(named('build')).toHaveAttribute('data-ignored', 'yes');
    await page.getByTestId('files-ignored-toggle').click();
    await expect(named('build')).toHaveCount(0);
    await page.getByTestId('files-ignored-toggle').click();
    await expect(named('build')).toHaveCount(1);

    await page.screenshot({ path: `${SHOTS}/bw-g3o312-file-tree.png`, animations: 'disabled' });

    // One click, one read: the folder's own level and nothing under it.
    const reads: string[] = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.pathname === '/api/fs/tree') reads.push(url.searchParams.get('dir') ?? '');
    });
    await named('src').click();
    await expect(named('src/main.ts')).toBeVisible({ timeout: WAIT });
    expect(reads, 'opening one folder read more than that folder').toEqual([`${FIXTURE}/src`]);
    // The folder below it is drawn shut and unread until it is asked for.
    await expect(named('src/lib')).toHaveAttribute('aria-expanded', 'false');

    // The arrows walk the tree. Clicking `src/lib` opens it and stands the
    // cursor on it; from there left shuts it, right opens it again, right once
    // more steps into what it holds, and Enter puts that file in the address.
    await page.getByTestId('files-tree-scroller').focus();
    await named('src/lib').click();
    await expect(named('src/lib/deep.ts')).toBeVisible({ timeout: WAIT });
    await page.keyboard.press('ArrowLeft');
    await expect(named('src/lib/deep.ts')).toHaveCount(0);
    await page.keyboard.press('ArrowRight');
    await expect(named('src/lib/deep.ts')).toBeVisible({ timeout: WAIT });
    await page.keyboard.press('ArrowRight');
    await expect(named('src/lib/deep.ts')).toHaveAttribute('data-cursor', 'yes');
    await page.keyboard.press('Enter');
    await expect.poll(() => new URL(page.url()).searchParams.get('file'), { timeout: WAIT })
      .toBe(`${FIXTURE}/src/lib/deep.ts`);
    await expect(named('src/lib/deep.ts')).toHaveAttribute('aria-selected', 'true');

    await page.screenshot({ path: `${SHOTS}/bw-g3o312-file-tree-opened.png`, animations: 'disabled' });

    // Now the big folder. It opens on one read, like any other.
    await named('many').click();
    await expect.poll(() => rows(page).count(), { timeout: WAIT }).toBeGreaterThan(20);

    // The scrollbar is the height of all five thousand rows…
    const scroller = page.getByTestId('files-tree-scroller');
    const total = await page.getByTestId('files-tree-row-list').evaluate((el) => el.getBoundingClientRect().height);
    expect(total, 'the tree is not as tall as the folder it is drawing').toBeGreaterThan(MANY * 20);

    // …while the page holds only what can be seen, plus the overscan.
    const drawnRows = await rows(page).count();
    expect(drawnRows, `the tree put ${drawnRows} rows in the page`).toBeLessThan(120);

    /**
     * Scroll the whole folder and watch every frame while it happens. Jank is
     * not a slow average — it is the one frame that took a tenth of a second
     * and showed the reader a blank strip — so it is the longest that is
     * asserted on, not the mean.
     */
    const slowestFrame: number = await scroller.evaluate(
      async (el) => {
        const gaps: number[] = [];
        let last = performance.now();
        let stop = false;
        const tick = () => {
          const now = performance.now();
          gaps.push(now - last);
          last = now;
          if (!stop) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        for (let step = 1; step <= 60; step += 1) {
          el.scrollTop = (el.scrollHeight - el.clientHeight) * (step / 60);
          await new Promise((go) => requestAnimationFrame(() => requestAnimationFrame(go)));
        }
        stop = true;
        await new Promise((go) => setTimeout(go, 50));
        // The first two gaps are the wait for the first frame, not work.
        return Math.max(...gaps.slice(2), 0);
      },
    );
    expect(
      slowestFrame,
      `the slowest frame while scrolling took ${Math.round(slowestFrame)}ms`,
    ).toBeLessThan(LONGEST_FRAME);

    // At the bottom, still only a screenful, and the last file is drawn.
    const atBottom = await rows(page).count();
    expect(atBottom, `the tree grew to ${atBottom} rows on the way down`).toBeLessThan(120);
    await expect(named(`many/page-0${MANY - 1}.ts`)).toBeVisible({ timeout: WAIT });

    await page.screenshot({ path: `${SHOTS}/bw-g3o312-file-tree-scrolled.png`, animations: 'disabled' });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
