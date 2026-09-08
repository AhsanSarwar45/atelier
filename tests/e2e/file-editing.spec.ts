import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import react from '@vitejs/plugin-react';
import { build, type RollupOutput } from 'vite';

import { display } from '../../scripts/product-name.js';

/**
 * A file typed into, saved, and read back off the disk (bw-g3o3.8).
 *
 * The one thing a unit test cannot show: the bytes actually landing. Everything
 * here is real — a real file in the home directory, the real read route, a real
 * `PUT /api/fs/write` through the real server, and the assertion made by
 * reading the file with node rather than by asking the page what it thinks. The
 * second half is the other direction: the file is edited from a shell, and the
 * viewer catches up with it on its own.
 *
 * The viewer is mounted on its own — see file-editing-harness.tsx — because the
 * Files tab is being furnished by several cards at once and has nowhere to hang
 * a file yet. The page is served by the app, so it keeps the app's origin and
 * its `/api/...` calls go to the server this run started.
 */

const RESULTS = 'tests/results';
const ROOT = resolve(__dirname, '..', '..');

const SAMPLE = `export interface Job {
  readonly id: string;
}

export function describeJob(job: Job): string {
  return \`job \${job.id}\`;
}
`;

/**
 * A directory inside the home directory, because every filesystem route is
 * jailed to it and the system temp directory is outside. Taken away again
 * afterwards: these are real files in the owner's home, not a temp tree the
 * machine sweeps up on its own.
 */
const SCRATCH = join(homedir(), '.atelier-e2e-file-editing');

function scratch(): string {
  mkdirSync(SCRATCH, { recursive: true });
  return mkdtempSync(join(SCRATCH, 'run-'));
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
        entry: resolve(__dirname, 'file-editing-harness.tsx'),
        formats: ['iife'],
        name: 'fileEditingHarness',
        fileName: () => 'harness.js',
      },
    },
  })) as RollupOutput[];
  const chunk = built[0]!.output.find((part) => part.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('the harness bundled to nothing');
  return chunk.code;
}

async function stylesheets(page: Page): Promise<string[]> {
  return page.$$eval('link[rel=stylesheet]', (links) => links.map((link) => (link as HTMLLinkElement).href));
}

let script: string;

test.beforeAll(async () => {
  mkdirSync(RESULTS, { recursive: true });
  script = await harnessScript();
});

test.afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

test.setTimeout(240_000);

/** Put the viewer on screen over `path`, in the app's own skin. */
async function open(page: Page, root: string, path: string) {
  page.on('pageerror', (error) => console.log(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') console.log(`console error: ${message.text()}`);
  });
  await page.setViewportSize({ width: 1100, height: 620 });
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
  await page.evaluate((asked) => {
    (window as unknown as { fileEditingHarness: unknown }).fileEditingHarness = asked;
  }, { root, path });
  await page.addScriptTag({ content: script });
  await expect(page.locator('.cm-content')).toContainText('describeJob');
}

/**
 * Type into a file that is still read-only.
 *
 * The first key is sent on its own and the flip waited for, because that flip
 * is a React render: a burst typed at a read-only view would have every key
 * arrive before the first one had turned it editable.
 */
async function typeIntoTheFile(page: Page, first: string, rest: string) {
  // The end of the document, so what is typed lands somewhere the assertions
  // can name rather than wherever the middle of the pane happened to be.
  await page.locator('.cm-line').last().click();
  await page.keyboard.press(first);
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
  await page.keyboard.type(rest, { delay: 20 });
}

test('types into a file, saves it, and the bytes are on disk', async ({ page }) => {
  const dir = scratch();
  const file = join(dir, 'jobs.ts');
  writeFileSync(file, SAMPLE);

  await open(page, dir, file);
  // Read-only until asked: there is an Edit button and no Save.
  await expect(page.getByTestId('file-viewer-edit')).toBeVisible();
  await expect(page.getByTestId('file-viewer-dirty')).toHaveCount(0);

  await typeIntoTheFile(page, 'e', 'xport const WIDTH = 4;\n');

  // The dot is the whole of what says there is work not on disk yet.
  await expect(page.getByTestId('file-viewer-dirty')).toBeVisible();
  await page.screenshot({ path: join(RESULTS, 'file-editing-unsaved.png') });
  expect(readFileSync(file, 'utf8')).not.toContain('WIDTH');

  await page.getByTestId('file-viewer-save').click();
  await expect(page.getByTestId('file-viewer-dirty')).toHaveCount(0);

  // The assertion that matters, made against the disk and not the page.
  await expect
    .poll(() => readFileSync(file, 'utf8'), { timeout: 15_000 })
    .toContain('export const WIDTH = 4;');
  expect(readFileSync(file, 'utf8')).toContain('describeJob');
  await page.screenshot({ path: join(RESULTS, 'file-editing-saved.png') });

  // Undo survives the save: the history is not cleared by writing.
  await page.locator('.cm-line').last().click();
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('file-viewer-dirty')).toBeVisible();
});

test('catches up with a file edited from a shell, and asks when there is work in hand', async ({ page }) => {
  const dir = scratch();
  const file = join(dir, 'jobs.ts');
  writeFileSync(file, SAMPLE);

  await open(page, dir, file);

  // Nothing typed, so a change on disk is simply taken.
  execFileSync('sh', ['-c', `printf '%s\\n' "// written from a shell" >> ${JSON.stringify(file)}`]);
  await expect(page.locator('.cm-content')).toContainText('written from a shell', { timeout: 20_000 });
  await page.screenshot({ path: join(RESULTS, 'file-editing-reloaded.png') });

  // Now with work in hand: the two texts are both real, so the reader chooses.
  await typeIntoTheFile(page, 'z', 'z = 1;\n');
  await expect(page.getByTestId('file-viewer-dirty')).toBeVisible();
  execFileSync('sh', ['-c', `printf '%s\\n' "// and again from the shell" >> ${JSON.stringify(file)}`]);

  await expect(page.getByTestId('file-viewer-outside')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.cm-content')).toContainText('zz = 1;');
  await page.screenshot({ path: join(RESULTS, 'file-editing-changed-underneath.png') });

  await page.getByTestId('file-viewer-reload').click();
  await expect(page.getByTestId('file-viewer-outside')).toHaveCount(0);
  await expect(page.locator('.cm-content')).toContainText('and again from the shell');
  await expect(page.locator('.cm-content')).not.toContainText('zz = 1;');
});
