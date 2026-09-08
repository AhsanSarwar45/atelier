import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import react from '@vitejs/plugin-react';
import { build, type RollupOutput } from 'vite';

import { display } from '../../scripts/product-name.js';

/**
 * Copying out of the file viewer copies a reference (bw-g3o3.10).
 *
 * This has to be proved in a browser and not only in jsdom, because the whole
 * feature is a browser's own behaviour being taken over: a real Selection over
 * the lines CodeMirror drew, a real Ctrl-C answered by the clipboard filter
 * rather than by the browser's own copy, and a real clipboard, read back
 * afterwards to see what is on it. The escape hatch is proved the same way —
 * the button beside the selection really does hand over the code — and so is
 * the tree's own Copy reference, for a file and for a folder.
 *
 * The selection is built through the DOM rather than by dragging the mouse: a
 * synthetic drag does not move the caret in this headless Chromium, and
 * dragging is the browser's business anyway. What has to be real here, and is,
 * is the Selection the browser ends up holding and the copy fired at it
 * (learned in bw-gr8y.8).
 *
 * The tree is reached through the app itself. The viewer is mounted on its own,
 * the way the other viewer cases mount it (file-viewer-harness.tsx), because
 * the Files tab does not put the viewer in its own pane yet — that is a card of
 * its own — and this behaviour is the viewer's wherever it is hung.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/copying-from-the-viewer-copies-a-reference.spec.ts
 */

/** Where a run leaves its proof; not the artifacts folder, which is emptied. */
const SHOTS = 'tests/results';
const ROOT = resolve(__dirname, '..', '..');
const FIXTURE = join(__dirname, '..', '.workbench-run-viewer-reference');
const WAIT = 60_000;

test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });
test.setTimeout(300_000);

function git(at: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: at, stdio: 'pipe' });
}

/** Ten numbered lines, so a line's number is readable in the picture. */
const SOURCE = `${Array.from({ length: 10 }, (_, at) => `const line${at + 1} = ${at + 1};`).join('\n')}\n`;

/** The four lines the reader will select, as they are written in the file. */
const LINES_4_TO_7 = 'const line4 = 4;\nconst line5 = 5;\nconst line6 = 6;\nconst line7 = 7;';

/** A checkout holding one file, in one folder, with numbered lines in it. */
function seedRepository(): void {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(FIXTURE, 'src'), { recursive: true });
  writeFileSync(join(FIXTURE, 'src', 'x.ts'), SOURCE);
  writeFileSync(join(FIXTURE, 'README.md'), '# copying a reference\n');
  git(FIXTURE, 'init', '-q', '-b', 'main', '.');
  git(FIXTURE, 'config', 'user.name', 'Atelier Tester');
  git(FIXTURE, 'config', 'user.email', 'tester@atelier.test');
  git(FIXTURE, 'config', 'commit.gpgsign', 'false');
  git(FIXTURE, 'add', '-A');
  git(FIXTURE, 'commit', '-qm', 'seed');
}

async function fixtureProject(request: APIRequestContext, path: string): Promise<{ id: string }> {
  const made = await request.post('/api/projects', { data: { name: 'viewer-reference', path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string };
}

/** The harness, bundled with the app's own toolchain, as one script to inject. */
async function harnessScript(): Promise<string> {
  const built = (await build({
    configFile: false,
    root: ROOT,
    logLevel: 'error',
    plugins: [react()],
    resolve: { alias: { '@': resolve(ROOT, 'src') } },
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.NEXT_PUBLIC_PRODUCT_NAME': JSON.stringify(display),
      'process.env': '{}',
    },
    build: {
      write: false,
      minify: false,
      lib: {
        entry: resolve(__dirname, 'file-viewer-harness.tsx'),
        formats: ['iife'],
        name: 'fileViewerHarness',
        fileName: () => 'harness.js',
      },
    },
  })) as RollupOutput[];
  const chunk = built[0]!.output.find((part) => part.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('the harness bundled to nothing');
  return chunk.code;
}

/** The app's stylesheets, as the page it was served on links them. */
async function stylesheets(page: Page): Promise<string[]> {
  return page.$$eval('link[rel=stylesheet]', (links) => links.map((link) => (link as HTMLLinkElement).href));
}

/** What the clipboard holds, and a sentinel to put on it beforehand. */
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const blank = (page: Page) => page.evaluate(() => navigator.clipboard.writeText('nothing has been copied yet'));

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

test('a tree entry copies @src/ for a folder and @src/x.ts for a file', async ({ page, request }) => {
  seedRepository();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  const project = await fixtureProject(request, FIXTURE);

  try {
    await page.goto(`/project?id=${project.id}&tab=files`);
    await page.getByTestId('files-tree').waitFor({ timeout: WAIT });

    const named = (path: string) => page.locator(`[data-testid="files-tree-row"][data-path="${FIXTURE}/${path}"]`);
    await expect(named('src')).toBeVisible({ timeout: WAIT });

    await blank(page);
    await named('src').click({ button: 'right' });
    await expect(page.getByTestId('files-tree-menu')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/bw-g3o310-tree-menu.png`, animations: 'disabled' });
    await page.getByTestId('files-tree-copy-reference').click();
    await expect
      .poll(() => clipboard(page), { message: 'the tree did not copy a folder as @src/' })
      .toBe('@src/');
    await expect(page.getByTestId('files-tree-menu')).toHaveCount(0);

    await named('src').click();
    await expect(named('src/x.ts')).toBeVisible({ timeout: WAIT });

    await blank(page);
    await named('src/x.ts').click({ button: 'right' });
    await page.getByTestId('files-tree-copy-reference').click();
    await expect
      .poll(() => clipboard(page), { message: 'the tree did not copy a file as @src/x.ts' })
      .toBe('@src/x.ts');
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});

test('a selection in the viewer copies @src/x.ts:4-7, and the code is one click away', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  page.on('pageerror', (error) => console.log(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') console.log(`console error: ${message.text()}`);
  });

  const script = await harnessScript();

  // Loaded from the app so the document keeps the app's origin — which is what
  // the clipboard permission was granted for, and what the stylesheet links
  // below resolve against.
  await page.goto('/');
  const sheets = await stylesheets(page);
  expect(sheets.length).toBeGreaterThan(0);
  await page.setContent(
    `<!doctype html>
<html class="dark">
  <head>${sheets.map((href) => `<link rel="stylesheet" href="${href}">`).join('')}
    <style>html, body { height: 100%; margin: 0; }
      body { background: hsl(var(--surface-base)); display: flex; }
      #harness { display: flex; flex: 1; min-width: 0; padding: 24px; }</style>
  </head>
  <body><div id="harness"></div></body>
</html>`,
    { waitUntil: 'load' },
  );
  await page.evaluate(
    (asked) => {
      (window as unknown as { fileViewerHarness: unknown }).fileViewerHarness = asked;
    },
    {
      root: '/home/reader/project',
      path: '/home/reader/project/src/x.ts',
      line: null,
      file: { kind: 'text' as const, text: SOURCE, size: SOURCE.length },
    },
  );
  await page.addScriptTag({ content: script });
  await expect(page.locator('.cm-content')).toContainText('const line1 = 1;');

  /** The reader's own selection, from the start of one line to the end of another. */
  const select = async (from: number, to: number) => {
    await page.getByTestId('file-viewer').evaluate(
      (node, where) => {
        const lines = [...node.querySelectorAll('.cm-line')];
        const first = lines[where.from - 1]!;
        const last = lines[where.to - 1]!;
        const range = document.createRange();
        range.setStart(first, 0);
        range.setEnd(last, last.childNodes.length);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      },
      { from, to },
    );
  };

  await select(4, 7);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('const line4');

  // The offer to take the code instead stands beside the selection.
  const offer = page.getByTestId('file-copy-text');
  await expect(offer).toBeVisible({ timeout: WAIT });
  await page.screenshot({ path: `${SHOTS}/bw-g3o310-viewer-selected.png`, animations: 'disabled' });

  await blank(page);
  await page.keyboard.press('ControlOrMeta+c');
  await expect
    .poll(() => clipboard(page), { message: 'copying a selection in the viewer did not write a reference' })
    .toBe('@src/x.ts:4-7');

  // And the button beside it hands over the lines it was drawn on.
  await offer.getByRole('button').click();
  await expect
    .poll(() => clipboard(page), { message: 'Copy text did not put the lines themselves on the clipboard' })
    .toBe(LINES_4_TO_7);

  // As does the one in the header, which is where a reader looks for it.
  await blank(page);
  await page.getByTestId('file-viewer-copy-text').click();
  await expect
    .poll(() => clipboard(page), { message: 'the header button did not copy the selected lines' })
    .toBe(LINES_4_TO_7);

  // One line is one number, never a range of one.
  await select(9, 9);
  await blank(page);
  await page.keyboard.press('ControlOrMeta+c');
  await expect
    .poll(() => clipboard(page), { message: 'one line was not copied as @src/x.ts:9' })
    .toBe('@src/x.ts:9');
});
