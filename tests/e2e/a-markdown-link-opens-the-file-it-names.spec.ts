import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * A README read in the Files tab follows its own links (bw-ewem.1).
 *
 * A markdown file writes its links the way a person writes them — `./notes.md`,
 * `../src/a.ts`, `guide/intro.md` — and every one of those means "next to me".
 * The app used to accept only an address written out in full, so every real
 * link in every real README left for the browser and landed on nothing.
 *
 * Only a browser can settle this: the words have to be read off disk by the
 * app's own route, drawn by the one renderer, and CLICKED, because where a
 * click lands is the router, the checkout list and the chip's marks agreeing.
 * So the fixture is a real repository with real files at those addresses, and
 * each link is clicked and the file it opened photographed.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-markdown-link-opens-the-file-it-names.spec.ts
 */

const SHOTS = 'tests/results';
const FIXTURE = join(__dirname, '..', '.workbench-run-markdown-links');
const MEDIA = join(__dirname, '..', 'fixtures', 'files-preview');
const WAIT = 60_000;

test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });
test.setTimeout(180_000);

/**
 * Every shape a README really uses: beside me, above me, below me, a line, an
 * anchor, a place in these same words, and the web.
 */
const README = `# Reading a README in place

![the app](./shot.png)

- beside it: [the notes](./notes.md)
- above it: [the source](../src/a.ts)
- below it: [the guide](guide/intro.md)
- a line of it: [the failing case](../src/a.ts#L3)
- a place in it: [installing](./guide/intro.md#installing)
- inside these words: [the list](#reading-a-readme-in-place)
- somewhere else entirely: [the dialect](https://commonmark.org)

Nothing above is an address written out in full, and every one of them names
something a reader of this file on disk would find.
`;

const NOTES = '# Notes\n\nThe file beside the README.\n';
const SOURCE = 'export const one = 1;\nexport const two = 2;\nexport const three = 3;\n';
const GUIDE = '# The guide\n\n## Installing\n\nRun it.\n';

function git(at: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: at, stdio: 'pipe' });
}

async function fixtureProject(request: APIRequestContext, name: string, path: string) {
  const made = await request.post('/api/projects', { data: { name, path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

/** The file the viewer is showing, whatever route the reader took to it. */
async function showing(page: Page, file: string): Promise<void> {
  await expect
    .poll(() => page.getByTestId('files-viewer').getAttribute('data-file'), { timeout: WAIT })
    .toBe(file);
}

test('a README opens the files its own links name', async ({ page, request }) => {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(FIXTURE, 'docs', 'guide'), { recursive: true });
  mkdirSync(join(FIXTURE, 'src'), { recursive: true });
  git(FIXTURE, 'init', '-q', '-b', 'main', '.');
  git(FIXTURE, 'config', 'user.name', 'Atelier Tester');
  git(FIXTURE, 'config', 'user.email', 'tester@atelier.test');
  git(FIXTURE, 'config', 'commit.gpgsign', 'false');
  git(FIXTURE, 'commit', '-qm', 'seed', '--allow-empty');

  const readme = join(FIXTURE, 'docs', 'README.md');
  const notes = join(FIXTURE, 'docs', 'notes.md');
  const guide = join(FIXTURE, 'docs', 'guide', 'intro.md');
  const source = join(FIXTURE, 'src', 'a.ts');
  writeFileSync(readme, README);
  writeFileSync(notes, NOTES);
  writeFileSync(guide, GUIDE);
  writeFileSync(source, SOURCE);
  copyFileSync(join(MEDIA, 'shot.png'), join(FIXTURE, 'docs', 'shot.png'));

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  const project = await fixtureProject(request, 'markdown-links', FIXTURE);

  try {
    mkdirSync(SHOTS, { recursive: true });

    const open = async () => {
      await page.goto(`/project?id=${project.id}&tab=files&file=${encodeURIComponent(readme)}`);
      await page.getByTestId('files-tab').waitFor({ timeout: WAIT });
      await showing(page, readme);
      await expect(page.getByTestId('file-preview')).toHaveAttribute('data-kind', 'markdown', { timeout: WAIT });
    };

    await open();
    const prose = page.getByTestId('file-preview-markdown');
    await expect(prose.locator('h1')).toHaveText('Reading a README in place', { timeout: WAIT });

    // Each written link, and the file on disk it means.
    const named = {
      './notes.md': notes,
      '../src/a.ts': source,
      'guide/intro.md': guide,
      './guide/intro.md#installing': guide,
    };
    for (const [written, meant] of Object.entries(named)) {
      const badge = prose.locator(`a[href="${written}"]`);
      await expect(badge, `${written} was not drawn as a file`).toHaveAttribute('data-path-mention', meant);
    }
    // A line named the way this app names one everywhere else.
    await expect(prose.locator('a[href="../src/a.ts#L3"]')).toHaveAttribute('data-path-line', '3');
    // The two that are not files: a place in these words, and the web.
    await expect(prose.locator('a[href="#reading-a-readme-in-place"]')).toHaveAttribute('data-testid', 'markdown-link');
    await expect(prose.getByTestId('markdown-web-badge')).toHaveAttribute('href', 'https://commonmark.org');

    // A picture written the same way is the same problem, and is drawn.
    const picture = prose.locator('img[data-testid=markdown-local-image]');
    await expect
      .poll(() => picture.evaluate((element: HTMLImageElement) => element.naturalWidth), { timeout: WAIT })
      .toBe(160);

    await page.screenshot({ path: `${SHOTS}/bw-ewem1-readme.png`, animations: 'disabled' });

    // ── Clicked, one at a time, each from a fresh reading of the README ──
    for (const [written, meant] of Object.entries(named)) {
      await open();
      await page.getByTestId('file-preview-markdown').locator(`a[href="${written}"]`).click();
      await showing(page, meant);
    }

    // The last of them, landed on: the guide, opened by an anchored link.
    await expect(page.getByTestId('file-preview-markdown').locator('h1')).toHaveText('The guide', { timeout: WAIT });
    await page.screenshot({ path: `${SHOTS}/bw-ewem1-landed-guide.png`, animations: 'disabled' });

    // And the one that walks upwards, since that is the shape that was most
    // obviously broken: the README's folder, not the project's.
    await open();
    await page.getByTestId('file-preview-markdown').locator('a[href="../src/a.ts"]').click();
    await showing(page, source);
    await expect(page.locator('.cm-content')).toContainText('export const one', { timeout: WAIT });
    await page.screenshot({ path: `${SHOTS}/bw-ewem1-landed-source.png`, animations: 'disabled' });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
