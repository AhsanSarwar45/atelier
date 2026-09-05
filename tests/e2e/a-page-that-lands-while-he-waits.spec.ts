import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { discardFixture, makeFixtureProject } from './fixture-board';
import { raggedChatSaidWithPictures, writeLongChat } from './fixture-record';

const HELLO_MS = 120_000;
const RUN = join(__dirname, '..', '.workbench-run-evidence');
const SHOTS = join(process.cwd(), 'tests', 'results');

test.setTimeout(300_000);

/**
 * A page that lands while the reader is standing still.
 *
 * Every other case here has the page arriving in the middle of a gesture, which
 * is the common one but also the forgiving one: the reader is moving anyway, so
 * a few pixels of correction land inside his own travel. This holds the page
 * back until the wheel is spent and the pane has stopped, and then asks the
 * plainest question there is — is the line he was reading still where it was?
 *
 * The row it follows is outlined in both shots, so the pair can be read at a
 * glance as well as counted.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-page-that-lands-while-he-waits.spec.ts
 */
test('the row he is reading is where it was, before the page and after it', async ({ page, request }) => {
  const where = join(RUN, 'evidence');
  const project = join(where, 'project');
  discardFixture(where);
  mkdirSync(where, { recursive: true });
  makeFixtureProject(project, join(where, 'reporting'));
  const made = await request.post('/api/projects', { data: { name: 'workbench-evidence', path: project } });
  expect(made.status(), await made.text()).toBe(201);
  const { id } = (await made.json()) as { id: string };
  const chat = writeLongChat({ cwd: project, sessionId: randomUUID(), held: 200, said: raggedChatSaidWithPictures });
  try {
    await page.goto(`/project?id=${id}&tab=chat`);
    await expect(page.getByTestId('chat-sidebar')).toBeVisible({ timeout: HELLO_MS });
    const row = page.locator(`[data-testid="restore-row"][data-external-id="${chat.sessionId}"]`);
    await row.waitFor({ timeout: HELLO_MS });
    await row.getByTestId('row-name').click();
    await page.getByTestId('virtual-transcript').waitFor({ timeout: HELLO_MS });
    await page.waitForTimeout(2500);

    // The older page is held back long enough that the reader's gesture is over
    // and the pane is standing still before it lands — so the two shots differ
    // by the arrival of forty messages and nothing else.
    await page.route('**/api/workbench/history**', async (route) => {
      if (route.request().url().includes('before=')) await new Promise((r) => setTimeout(r, 4000));
      await route.continue();
    });

    await page.evaluate(() => {
      const box = document.querySelector('[data-testid="transcript"]') as HTMLElement;
      box.scrollTop = box.clientHeight + 40;
    });
    await page.waitForTimeout(500);

    const mark = async (): Promise<number> =>
      page.evaluate(() => {
        const box = document.querySelector('[data-testid="transcript"]') as HTMLElement;
        const top = box.getBoundingClientRect().top;
        const held = (window as unknown as { __row?: string }).__row;
        const rows = [...box.querySelectorAll<HTMLElement>('[data-transcript-key]')];
        let el: HTMLElement | null = null;
        if (held) {
          // By the key and nothing else. Falling back to whatever is at the top
          // when the row cannot be found would compare two different rows and
          // call the answer a measurement.
          el = rows.find((r) => r.dataset.transcriptKey === held) ?? null;
          if (!el) throw new Error(`the row being followed is no longer drawn: ${held}`);
        } else {
          el = rows.reduce((best, r) =>
            r.getBoundingClientRect().top > top + 8 &&
            (!best || r.getBoundingClientRect().top < best.getBoundingClientRect().top)
              ? r
              : best,
          null as HTMLElement | null) ?? rows[0]!;
          (window as unknown as { __row?: string }).__row = el.dataset.transcriptKey;
        }
        el.style.outline = '3px solid #f59e0b';
        el.style.outlineOffset = '2px';
        return Math.round(el.getBoundingClientRect().top - top);
      });

    await page.getByTestId('transcript').hover();
    for (let i = 0; i < 8; i += 1) {
      await page.mouse.wheel(0, -25);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(1200);
    const before = await mark();
    await page.screenshot({ path: join(SHOTS, 'bw-cdav-before-the-page.png') });

    await page.waitForTimeout(5000);
    const after = await mark();
    await page.screenshot({ path: join(SHOTS, 'bw-cdav-after-the-page.png') });

    const loaded = await page.evaluate(
      () => Number((document.querySelector('[data-testid="virtual-transcript"]') as HTMLElement).dataset.loadedItems),
    );
    // eslint-disable-next-line no-console
    console.log('the pair', JSON.stringify({ before, after, loaded }));
    expect(loaded, 'no older page arrived between the two shots').toBeGreaterThan(40);
    expect(Math.abs(after - before), `the marked row moved: ${before} then ${after}`).toBeLessThanOrEqual(2);
  } finally {
    chat.remove();
    await request.delete(`/api/projects/${id}`);
  }
});
