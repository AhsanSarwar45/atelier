import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { ruledPng } from './fixture-png';

/**
 * Every preview the Files tab can draw, at 390px (bw-e3dw.5).
 *
 * The survey (bw-e3dw.1) saw the previews broken, but it saw them in a 102px
 * viewer — the Files tab gave its tree 288px of a 390px screen and drew the
 * file in what was left. bw-e3dw.2 has since made the tree a sheet and given
 * the viewer the whole 390px, so the question this case asks is not the one the
 * item was written with: it is whether each preview fits the width it is NOW
 * given. Markdown, image, SVG, video, and PDF are each opened and measured, and
 * a preview that already fits is left alone.
 *
 * The measurement is deliberately blunt and the same for all five: nothing
 * drawn inside the preview may reach past its right edge, and no box inside it
 * may hold more than it shows — except a fenced code block, which the one
 * markdown renderer deliberately gives its own sideways scroll rather than let
 * a pasted command widen the column (`markdown-body.tsx`).
 *
 * Run: PHONE_PREVIEW_STAGE=before scripts/workbench-e2e.sh tests/e2e/the-previews-on-a-phone.spec.ts
 */

const STAGE = process.env.PHONE_PREVIEW_STAGE ?? 'now';
const SHOTS = `tests/results/previews-phone/${STAGE}`;
const MEDIA = join(__dirname, '..', 'fixtures', 'files-preview');
const WAIT = 60_000;

const PHONE = { width: 390, height: 844 };

test.use({ viewport: PHONE, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

/**
 * Everything a written page can be that is wider than a phone: a heading, a
 * prose paragraph, a four-column table, a fenced line of code, an address with
 * no spaces in it, and a picture bigger than the screen.
 */
const MARKDOWN = `# The project, read on a phone

A paragraph that is long enough to need wrapping when the screen is only three
hundred and ninety pixels wide, which is the whole question this case asks.

| Column one | Column two | Column three | Column four |
| --- | --- | --- | --- |
| a value | another value | a third value | a fourth value |

\`\`\`ts
const aLineOfCodeThatIsFarTooLongToFitOnAPhoneScreenAndMustDoSomething = 1;
\`\`\`

https://example.invalid/an/address/with/no/spaces/in/it/that/cannot/be/wrapped/anywhere

![a picture wider than the screen](./assets/wide.png)
`;

/** Wider than 390px on purpose: a drawing has to be scaled down to fit. */
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="500" viewBox="0 0 900 500">
  <rect x="20" y="20" width="860" height="460" rx="24" fill="#519aba" />
  <circle cx="450" cy="250" r="180" fill="#e37933" />
</svg>
`;

/** The smallest thing a browser will agree is a PDF: one blank A4 page. */
function onePagePdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << >> >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, at) => {
    offsets.push(body.length);
    body += `${at + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const measured: string[] = [];
function note(what: string): void {
  measured.push(what);
}

function git(at: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd: at,
    stdio: 'pipe',
  });
}

function seed(where: string): void {
  rmSync(where, { recursive: true, force: true });
  mkdirSync(join(where, 'assets'), { recursive: true });
  writeFileSync(join(where, 'README.md'), MARKDOWN);
  writeFileSync(join(where, 'assets', 'drawing.svg'), SVG);
  writeFileSync(join(where, 'assets', 'paper.pdf'), onePagePdf());
  copyFileSync(join(MEDIA, 'shot.png'), join(where, 'assets', 'shot.png'));
  // Three times the width of the screen, so "it fits" cannot be true merely
  // because the picture was small.
  writeFileSync(join(where, 'assets', 'wide.png'), ruledPng(1200, 800));
  copyFileSync(join(MEDIA, 'clip.mp4'), join(where, 'assets', 'clip.mp4'));

  git(where, 'init', '-q', '-b', 'main', '.');
  git(where, 'config', 'user.name', 'Phone Previews');
  git(where, 'config', 'user.email', 'phone-previews@atelier.test');
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

/** Put the Files tab's tree where the next step needs it, however it opened. */
async function tree(page: Page, want: 'open' | 'shut'): Promise<void> {
  const toggle = page.getByTestId('files-rail-toggle');
  if ((await toggle.count()) === 0) return;
  const rail = page.getByTestId('files-rail');
  if (((await rail.getAttribute('data-open')) === 'true') !== (want === 'open')) {
    await toggle.click();
    await page.waitForTimeout(700);
  }
}

interface Fit {
  /** How wide the preview itself is. */
  preview: number;
  /** The furthest right anything inside it is drawn, from the preview's left. */
  reach: number;
  /** Boxes holding more than they show, other than a fenced block. */
  over: string[];
  /** The whole document against the window. */
  document: number;
  window: number;
}

/** Does everything drawn in the preview fit the width the preview was given? */
async function fitOf(page: Page): Promise<Fit> {
  return page.evaluate(() => {
    const preview = document.querySelector('[data-testid="file-preview"]') as HTMLElement | null;
    if (!preview) throw new Error('no preview was drawn');
    const box = preview.getBoundingClientRect();
    let reach = 0;
    const over: string[] = [];
    for (const el of Array.from(preview.querySelectorAll<HTMLElement>('*'))) {
      // A fenced block is given its own sideways scroll on purpose, so that a
      // pasted command cannot widen the column it sits in
      // (`markdown-body.tsx`). Its contents are meant to reach past its edge,
      // and are the one thing not asked either question.
      if (el.tagName === 'PRE' || el.closest('pre')) continue;
      const own = el.getBoundingClientRect();
      if (own.width > 0) reach = Math.max(reach, Math.round(own.right - box.left));
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      if (el.clientWidth < 24 || el.scrollWidth - el.clientWidth < 8) continue;
      const name = el.getAttribute('data-testid') ?? el.tagName.toLowerCase();
      over.push(`${name} holds ${el.scrollWidth}px in ${el.clientWidth}px`);
    }
    return {
      preview: Math.round(box.width),
      reach,
      over: over.slice(0, 6),
      document: document.documentElement.scrollWidth,
      window: document.documentElement.clientWidth,
    };
  });
}

test('the previews on a phone: markdown, a picture, a drawing, a film and a paper each fit 390px', async ({ page, request }) => {
  test.setTimeout(600_000);
  const fixture = join(__dirname, '..', '.workbench-run-phone-previews');
  seed(fixture);

  await seeTestProjects(page);
  const project = await fixtureProject(request, 'phone-previews', fixture);
  mkdirSync(SHOTS, { recursive: true });

  const named = (path: string) =>
    page.locator(`[data-testid="files-tree-row"][data-path="${fixture}/${path}"]`);

  /** Open one file from the tree and measure what the viewer made of it. */
  async function look(path: string, kind: string, shot: string): Promise<Fit> {
    await tree(page, 'open');
    if (path.includes('/')) {
      await named(path.slice(0, path.indexOf('/'))).click();
      await page.waitForTimeout(500);
    }
    await named(path).click();
    await expect(page.getByTestId('file-preview')).toHaveAttribute('data-kind', kind, { timeout: WAIT });
    await page.waitForTimeout(2000);
    const fit = await fitOf(page);
    note(
      `${path} (${kind}) at 390px: the preview is ${fit.preview}px and the furthest anything inside it reaches is ${fit.reach}px` +
        `; ${fit.over.length ? fit.over.join('; ') : 'nothing holds more than it shows'}` +
        `; the document is ${fit.document}px in ${fit.window}px`,
    );
    await page.screenshot({ path: `${SHOTS}/${shot}.png`, animations: 'disabled' });
    return fit;
  }

  /** Everything drawn inside the preview is inside the preview. */
  function fits(what: string, fit: Fit): void {
    expect(fit.reach, `${what} is drawn past the right edge of the preview`).toBeLessThanOrEqual(fit.preview + 1);
    expect(fit.over, `${what} holds more than it shows`).toEqual([]);
    expect(fit.document, `${what} scrolls the page sideways`).toBeLessThanOrEqual(fit.window + 1);
  }

  try {
    await page.goto(`/project?id=${project.id}&tab=files`);
    await page.getByTestId('files-tree').waitFor({ timeout: WAIT });
    await expect(page.getByTestId('files-tab')).toHaveAttribute('data-root', fixture, { timeout: WAIT });
    await page.waitForTimeout(1500);

    fits('the Markdown preview', await look('README.md', 'markdown', '01-markdown'));
    fits('the picture preview', await look('assets/shot.png', 'image', '02-image'));
    // A picture is shown at its own pixel size with a zoom, by decision
    // (`file-preview.tsx`, and `a-picture-zooms-under-the-wheel.spec.ts` holds
    // it to opening at 100%), so a picture wider than the stage starts cropped
    // rather than shrunk. Whether a phone should instead open it fitted is
    // bw-e3dw.4's ground, not this item's. What belongs here is only that the
    // crop is a crop and not an overflow: the stage keeps it and the page does
    // not move sideways. So it is measured, but not asked the other question.
    const wideFit = await look('assets/wide.png', 'image', '02b-image-wide');
    expect(wideFit.document, 'a wide picture moves the page sideways').toBeLessThanOrEqual(wideFit.window + 1);
    const wide = await page.evaluate(() => {
      const stage = document.querySelector('[data-testid="file-preview-image-stage"]') as HTMLElement | null;
      const picture = document.querySelector('[data-testid="file-preview-image"]') as HTMLElement | null;
      return {
        stage: stage ? Math.round(stage.getBoundingClientRect().width) : -1,
        picture: picture ? Math.round(picture.getBoundingClientRect().width) : -1,
        scale: stage?.getAttribute('data-scale') ?? 'none',
        clipped: stage ? getComputedStyle(stage).overflowX : 'none',
      };
    });
    note(
      `assets/wide.png at 390px: a ${wide.picture}px picture on a ${wide.stage}px stage at ${wide.scale}x, ` +
        `overflow-x: ${wide.clipped} — the stage keeps it rather than the page carrying it`,
    );
    expect(wide.clipped, 'a picture wider than the stage is not kept by the stage').toBe('hidden');
    fits('the SVG preview', await look('assets/drawing.svg', 'svg', '03-svg'));
    fits('the video preview', await look('assets/clip.mp4', 'video', '04-video'));
    fits('the PDF preview', await look('assets/paper.pdf', 'pdf', '05-pdf'));

    // The strip the item also names. The survey found it already right, and
    // this is the crowded case it has to be right in: a click in the tree only
    // ever *previews*, taking the one preview slot, so the strip is filled the
    // way a working reader fills it — with files that were pinned — and read
    // back from where the app remembers them (`open-files.ts`).
    await page.evaluate(({ id, at }) => {
      const files = ['README.md', 'assets/shot.png', 'assets/wide.png', 'assets/drawing.svg', 'assets/clip.mp4', 'assets/paper.pdf'];
      localStorage.setItem(
        `workbench.open-files.${id}`,
        JSON.stringify(files.map((path) => ({ path: `${at}/${path}`, preview: false }))),
      );
    }, { id: project.id, at: fixture });
    await page.goto(`/project?id=${project.id}&tab=files&file=${encodeURIComponent(`${fixture}/README.md`)}`);
    await expect(page.getByTestId('open-files-strip')).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(2000);
    const strip = await page.getByTestId('open-files-strip').evaluate((el) => ({
      tabs: el.querySelectorAll('[data-testid="open-file"]').length,
      shown: el.clientWidth,
      holds: el.scrollWidth,
      overflow: getComputedStyle(el).overflowX,
    }));
    note(
      `the open-files strip with ${strip.tabs} files open at 390px: ${strip.holds}px of tabs in ${strip.shown}px, overflow-x: ${strip.overflow}`,
    );
    expect(strip.tabs, 'the strip did not fill').toBe(6);
    expect(strip.overflow, 'the strip cannot be swiped').toBe('auto');
    expect(strip.shown, 'the strip is not the width of the screen').toBeLessThanOrEqual(PHONE.width);
    expect(strip.holds, 'the crowded strip is not actually crowded').toBeGreaterThan(strip.shown);
    const page390 = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      window: document.documentElement.clientWidth,
    }));
    note(`with the strip crowded, the document is ${page390.document}px in ${page390.window}px`);
    expect(page390.document, 'the crowded strip takes the page sideways with it').toBeLessThanOrEqual(page390.window + 1);
    await page.screenshot({ path: `${SHOTS}/06-strip.png`, animations: 'disabled' });
  } finally {
    const report = ['', `======== THE PREVIEWS ON A PHONE (${STAGE}) ========`, '', ...measured.map((one) => `   * ${one}`), ''].join('\n');
    console.log(report);
    writeFileSync(`${SHOTS}/measurements.txt`, report);
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
