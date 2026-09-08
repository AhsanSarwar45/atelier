import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import react from '@vitejs/plugin-react';
import { build, type RollupOutput } from 'vite';

import { display } from '../../scripts/product-name.js';

/**
 * The same file, in a dark skin and in a light one.
 *
 * The whole point of the viewer's theme is that a keyword is not painted with a
 * colour but with `var(--code-keyword)`, so the only way to know it worked is
 * to look: one screenshot per mode, of one file, with the grammar loaded and
 * the line the address named marked. A unit test can prove a class is on a
 * span; it cannot prove the span is legible on a white page (bw-g3o3.17).
 *
 * The tab that will hold the viewer is bw-g3o3.4, still being built, so the
 * component is mounted on its own — see file-viewer-harness.tsx — into a
 * document wearing the app's real stylesheet, served by the app itself.
 */

const RESULTS = 'tests/results';
const ROOT = resolve(__dirname, '..', '..');

/** A file with one of everything the twelve inks are for. */
const SAMPLE = `/**
 * A queue that runs a few jobs at a time and no more.
 */
import { EventEmitter } from 'node:events';

export interface Job<T> {
  readonly id: string;
  readonly run: () => Promise<T>;
}

const DEFAULT_WIDTH = 4;

export class Queue<T> extends EventEmitter {
  private waiting: Job<T>[] = [];
  private running = 0;

  constructor(private readonly width: number = DEFAULT_WIDTH) {
    super();
    if (width < 1) throw new RangeError(\`a width of \${width} runs nothing\`);
  }

  /** Add a job; it starts as soon as there is room for it. */
  add(job: Job<T>): void {
    this.waiting.push(job);
    this.pump();
  }

  private pump(): void {
    while (this.running < this.width && this.waiting.length > 0) {
      const job = this.waiting.shift()!;
      this.running += 1;
      void job
        .run()
        .then((answer) => this.emit('done', job.id, answer))
        .catch((error: unknown) => this.emit('failed', job.id, error))
        .finally(() => {
          this.running -= 1;
          this.pump();
        });
    }
  }
}
`;

const FILE = {
  root: '/home/reader/project',
  path: '/home/reader/project/src/lib/queue.ts',
  line: 23,
  file: { kind: 'text' as const, text: SAMPLE, size: SAMPLE.length },
};

/** The harness, bundled with the app's own toolchain, as one script to inject. */
async function harnessScript(): Promise<string> {
  const built = (await build({
    configFile: false,
    root: ROOT,
    logLevel: 'error',
    plugins: [react()],
    resolve: { alias: { '@': resolve(ROOT, 'src') } },
    // A browser has no `process`, and the screens read two values off it at
    // build time — the same two the real build and the unit tests hand over.
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

let script: string;

test.beforeAll(async () => {
  mkdirSync(RESULTS, { recursive: true });
  script = await harnessScript();
});

test.setTimeout(180_000);

for (const skin of [
  { id: 'default', mode: 'dark', shot: 'file-viewer-dark.png' },
  { id: 'github-clean', mode: 'light', shot: 'file-viewer-light.png' },
] as const) {
  test(`draws the file in the ${skin.mode} skin, ${skin.id}`, async ({ page }) => {
    // The component is mounted by an injected script, so a mistake in it is
    // otherwise only ever "the element was not found".
    page.on('pageerror', (error) => console.log(`page error: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') console.log(`console error: ${message.text()}`);
    });
    await page.setViewportSize({ width: 1100, height: 760 });
    // Loaded from the app so the document keeps the app's origin, and the
    // stylesheet links below resolve against the server that just served them.
    await page.goto('/');
    const sheets = await stylesheets(page);
    expect(sheets.length).toBeGreaterThan(0);

    await page.setContent(
      `<!doctype html>
<html class="${skin.mode}"${skin.id === 'default' ? '' : ` data-theme="${skin.id}"`}>
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
      (window as unknown as { fileViewerHarness: unknown }).fileViewerHarness = asked;
    }, FILE);
    await page.addScriptTag({ content: script });

    await expect(page.getByTestId('file-viewer-breadcrumb')).toContainText('queue.ts');
    await expect(page.getByTestId('file-viewer-size')).toBeVisible();
    // The grammar is fetched after the mount, so wait for a coloured token
    // rather than for the text: an uncoloured screenshot would pass silently.
    await expect
      .poll(async () =>
        page.$$eval('.cm-content span[class]', (spans) =>
          spans.filter((span) => span.className.startsWith('ͼ')).map((span) => span.textContent),
        ),
      )
      .toContain('import');
    await expect(page.locator('.cm-highlighted-line')).toContainText('add(job: Job<T>)');

    // The inks have to differ per skin; a page where every token resolved to
    // the same colour is exactly the failure the screenshots are here to catch.
    const inks = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return ['keyword', 'string', 'comment', 'number', 'function'].map((role) =>
        style.getPropertyValue(`--code-${role}`).trim(),
      );
    });
    expect(new Set(inks).size).toBe(inks.length);

    await page.screenshot({ path: join(RESULTS, skin.shot) });
  });
}
