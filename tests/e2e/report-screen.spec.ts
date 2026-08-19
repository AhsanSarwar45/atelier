import { existsSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * A report as a place under its project (bw-7ks.21.4).
 *
 * What this proves, and what the manager asked for in his own words: a report
 * opens INSIDE the app — the same two bars the board and the chats sit under,
 * never a page of its own held in a frame — with its contents pinned at the
 * window's left edge, the report itself at a reading width, and its links
 * beside it. Three shapes, decided by how wide the window is:
 *
 *   1440  contents at the left edge | reading column | links on the right
 *   1150  contents at the left edge, links beneath them | reading column
 *    800  contents and links in a strip across the top, report beneath
 *
 * Needs an instance holding a project that has at least one report built for
 * it. Pick the project with BEADS_E2E_PROJECT and the report with
 * BEADS_E2E_REPORT, or the first of each the instance lists.
 *
 * Run: BEADS_E2E_URL=http://127.0.0.1:3017 BEADS_E2E_BACKEND=http://127.0.0.1:3017 \
 *      npx playwright test tests/e2e/report-screen.spec.ts
 */

/** Where the photographs the job is judged on are written. */
const SHOTS = 'tests/results';

/** The widest a reading column may be before the eye starts losing its place. */
const READING_MAX = 780;

function api(): string {
  return process.env.BEADS_E2E_BACKEND ?? '';
}

interface ProjectRow {
  id: string;
  path?: string;
  localPath?: string | null;
}

/** Every project the instance holds — there is no address for one on its own. */
async function projects(request: APIRequestContext): Promise<ProjectRow[]> {
  const rows = (await (await request.get(`${api()}/api/projects`)).json()) as ProjectRow[];
  expect(rows.length, 'the instance lists no projects').toBeGreaterThan(0);
  return rows;
}

async function projectId(request: APIRequestContext): Promise<string> {
  if (process.env.BEADS_E2E_PROJECT) return process.env.BEADS_E2E_PROJECT;
  return (await projects(request))[0].id;
}

/** A report the instance actually holds for that project. */
async function reportSlug(request: APIRequestContext, id: string): Promise<string> {
  if (process.env.BEADS_E2E_REPORT) return process.env.BEADS_E2E_REPORT;
  const row = (await projects(request)).find((p) => p.id === id);
  const dir = row?.localPath || row?.path || '';
  const name = dir.split(/[\\/]/).filter(Boolean).pop() ?? '';
  const reports = (await (await request.get(`${api()}/api/reports`)).json()) as {
    project: string;
    slug: string;
  }[];
  const ours = reports.filter((r) => r.project === name);
  expect(ours.length, `the instance holds no report for ${name}`).toBeGreaterThan(0);
  return ours[0].slug;
}

async function openReport(page: Page, id: string, slug: string): Promise<void> {
  await page.goto(`/project?id=${id}&tab=reports&report=${slug}`);
  await expect(page.getByTestId('report-tab')).toBeVisible();
  // The document itself, not the loading line: everything below measures the
  // drawn report.
  await expect(page.getByTestId('report-part').first()).toBeVisible({ timeout: 90_000 });
}

/** The box a part of the screen occupies, in window coordinates. */
async function box(page: Page, testId: string) {
  const found = await page.getByTestId(testId).first().boundingBox();
  expect(found, `${testId} is not on the screen`).not.toBeNull();
  return found!;
}

test.describe('a report is a place under its project', () => {
  // Opening a report runs the report tools against the board, which takes
  // seconds, and the suite runs its own tests side by side — so the wait here
  // is the builder's, not the screen's (bw-7ks.21.9 makes the second visit
  // instant).
  test.describe.configure({ timeout: 120_000 });

  test('it opens inside the app, under the same two bars as the board', async ({ page, request }) => {
    const id = await projectId(request);
    const slug = await reportSlug(request, id);
    await openReport(page, id, slug);

    // The shell, unchanged: the project's own bar and the tab bar, and nothing
    // else above the work.
    await expect(page.locator('[data-shell-bar]')).toHaveCount(2);
    await expect(page.getByTestId('project-name')).toBeVisible();
    await expect(page.getByTestId('project-menu')).toBeVisible();
    await expect(page.getByTestId('project-tabs')).toBeVisible();
    await expect(page.getByTestId('tab-reports')).toBeVisible();

    // Not a page held in a frame: the report is drawn by the app itself.
    await expect(page.locator('iframe')).toHaveCount(0);

    // The window itself never scrolls — the report's own pane does.
    const overflow = await page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return el.scrollHeight - el.clientHeight;
    });
    expect(overflow, 'the window itself scrolls').toBeLessThanOrEqual(1);
  });

  test('the address carries the report, so Back and a pasted link both work', async ({ page, request }) => {
    const id = await projectId(request);
    const slug = await reportSlug(request, id);

    await page.goto(`/project?id=${id}&tab=board`);
    await expect(page.getByTestId('project-tabs')).toBeVisible();

    await page.getByTestId('tab-reports').click();
    await expect(page.getByTestId('report-tab')).toBeVisible();
    await page.getByTestId('reports-list-item').first().click();
    await expect(page).toHaveURL(/report=/);
    await expect(page.getByTestId('report-part').first()).toBeVisible({ timeout: 90_000 });

    // A fresh window on the same address lands on the same report.
    await page.reload();
    await expect(page.getByTestId('report-part').first()).toBeVisible({ timeout: 90_000 });

    // Back steps off the report, then off the tab, and the board is there.
    await page.goBack();
    await page.goBack();
    await expect(page).toHaveURL(/tab=board/);
    expect(slug.length, 'a report slug was resolved').toBeGreaterThan(0);
  });

  test('wide: contents at the left edge, a reading column, links on the right', async ({ page, request }) => {
    const id = await projectId(request);
    const slug = await reportSlug(request, id);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openReport(page, id, slug);

    const toc = await box(page, 'report-toc');
    const pane = await box(page, 'report-pane');
    const links = await box(page, 'report-links');
    const column = await box(page, 'report-column');

    expect(toc.x, 'the contents are not pinned to the window edge').toBeLessThanOrEqual(1);
    expect(pane.x, 'the report starts left of the contents').toBeGreaterThan(toc.x + toc.width - 1);
    expect(links.x, 'the links are not right of the report').toBeGreaterThan(pane.x);
    expect(column.width, 'the reading column is too wide').toBeLessThanOrEqual(READING_MAX);
    // Wider than the drawer it replaces, which never took more than half.
    expect(column.width).toBeGreaterThan(480);

    await page.screenshot({ path: `${SHOTS}/bw-7ks.21-report-1440.png`, fullPage: false });
  });

  test('middle: the links move under the contents', async ({ page, request }) => {
    const id = await projectId(request);
    const slug = await reportSlug(request, id);
    await page.setViewportSize({ width: 1150, height: 900 });
    await openReport(page, id, slug);

    const toc = await box(page, 'report-toc');
    const links = await box(page, 'report-links');
    const pane = await box(page, 'report-pane');
    const column = await box(page, 'report-column');

    expect(toc.x, 'the contents left the window edge').toBeLessThanOrEqual(1);
    expect(links.y, 'the links are not under the contents').toBeGreaterThanOrEqual(toc.y + toc.height - 1);
    expect(links.x, 'the links left the contents column').toBeLessThan(pane.x);
    expect(column.width, 'the reading column is too wide').toBeLessThanOrEqual(READING_MAX);

    await page.screenshot({ path: `${SHOTS}/bw-7ks.21-report-1150.png`, fullPage: false });
  });

  test('narrow: contents and links in a strip across the top', async ({ page, request }) => {
    const id = await projectId(request);
    const slug = await reportSlug(request, id);
    await page.setViewportSize({ width: 800, height: 900 });
    await openReport(page, id, slug);

    const toc = await box(page, 'report-toc');
    const links = await box(page, 'report-links');
    const pane = await box(page, 'report-pane');

    expect(toc.x, 'the contents left the window edge').toBeLessThanOrEqual(1);
    expect(pane.y, 'the report is not beneath the strip').toBeGreaterThanOrEqual(links.y + links.height - 1);
    expect(pane.x, 'the report does not take the full width').toBeLessThanOrEqual(1);
    expect(pane.width, 'the report does not take the full width').toBeGreaterThan(760);

    // A strip, not a banner: a card whose title is a whole sentence must not
    // grow the links into a block, nor push the window sideways.
    expect(links.height, 'the links are a block rather than a strip').toBeLessThanOrEqual(140);
    const sideways = await page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(sideways, 'something pushes the whole window sideways').toBeLessThanOrEqual(1);

    await page.screenshot({ path: `${SHOTS}/bw-7ks.21-report-800.png`, fullPage: false });
  });

  test('the contents scroll the report to the part they name', async ({ page, request }) => {
    const id = await projectId(request);
    const slug = await reportSlug(request, id);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openReport(page, id, slug);

    const items = page.getByTestId('report-toc-item');
    const count = await items.count();
    expect(count, 'the contents name no part of the report').toBeGreaterThan(2);

    const before = await page.getByTestId('report-pane').evaluate((el) => el.scrollTop);
    await items.nth(count - 1).click();
    await expect
      .poll(async () => page.getByTestId('report-pane').evaluate((el) => el.scrollTop), {
        message: 'clicking the last entry moved nothing',
        timeout: 5_000,
      })
      .toBeGreaterThan(before);
  });
});

/**
 * A report of our own, so the three things below can be measured rather than
 * waited for: a question that is holding up a card the board really is
 * working on, and enough sections that the last one is well below the fold.
 *
 * It is written where the instance keeps its reports and taken away again
 * afterwards — there is no address for putting a report in, and a report the
 * manager already has says nothing about a question, which is the case worth
 * proving (bw-7ks.21.7).
 */
const FIXTURE = 'zz-screen-check';

function reportsHome(project: string): string {
  const data = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(data, 'kanban-ui', 'reports', project);
}

function fixturePaths(project: string): string[] {
  const home = reportsHome(project);
  return [`${FIXTURE}.report.json`, `${FIXTURE}.json`, `${FIXTURE}.html`].map((n) => join(home, n));
}

interface Fixture {
  /** The project the report is filed under, as the reports folder names it. */
  project: string;
  /** The folder its board lives in. */
  dir: string;
  card: string;
  column: string;
}

function section(label: string, text: string) {
  return {
    label,
    blocks: [
      { kind: 'note', tone: 'good', label: 'Result', text },
      {
        kind: 'table',
        columns: ['Where', { name: 'Reading', align: 'num' }],
        rows: [
          ['Before', { num: '2.4' }],
          ['After', { num: '9.1' }],
        ],
      },
    ],
  };
}

/** Writes the fixture report and says what it is holding up. */
async function writeFixture(request: APIRequestContext, id: string): Promise<Fixture> {
  const row = (await projects(request)).find((p) => p.id === id);
  const dir = row?.localPath || row?.path || '';
  const project = basename(dir);
  const home = reportsHome(project);
  expect(existsSync(home), `this instance keeps no reports at ${home}`).toBe(true);

  const board = (await (
    await request.get(`${api()}/api/beads?path=${encodeURIComponent(dir)}`)
  ).json()) as { beads: { id: string; status: string }[] };
  const working = board.beads.find((b) => b.status === 'in_progress');
  const live = working ?? board.beads.find((b) => b.status === 'open');
  expect(live, 'the board holds no card that is still open').toBeTruthy();

  writeFileSync(
    join(home, `${FIXTURE}.report.json`),
    JSON.stringify({
      title: 'Screen Check',
      actions: {
        questions: [
          {
            ask: 'Keep the wider column, or go back to the narrow one?',
            options: [
              { label: 'Keep it', say: 'Keep the wider column.', pick: true },
              { label: 'Go back', say: 'Go back to the narrow column.' },
            ],
            note: 'A morning of work either way',
            holds: live!.id,
          },
        ],
      },
      status: {
        now: 'Waiting on your answer above.',
        next_up: 'The narrow column comes back the moment you say so.',
        items: [
          { state: 'done', text: 'Measured the old column' },
          { state: 'todo', text: 'Read a long report at the new width' },
        ],
      },
      content: [
        section('What changed', 'The column is wider and the eye keeps its place.'),
        section('What it cost', 'A morning, and nothing else moved.'),
        section('What is left', 'The narrow column is still there behind a setting.'),
        section('What we watched', 'Every width from a phone to a wall screen.'),
      ],
      decisions: [
        { id: 'D1', title: 'The column is as wide as a page of a book', why: 'The eye loses its place past that.' },
        { id: 'D2', title: 'The contents stay at the left edge' },
      ],
      next: {
        if_nothing: 'The wider column stays.',
        steps: [{ step: 'Read a long report at the new width', cost: 'small', starting: true }],
      },
    }),
  );

  return { project, dir, card: live!.id, column: working ? 'In Progress' : 'Todo' };
}

test.describe('a report says what it is holding up, and lands where it is pointed', () => {
  test.describe.configure({ timeout: 120_000 });

  let fixture: Fixture | null = null;

  test.afterAll(() => {
    if (!fixture) return;
    for (const path of fixturePaths(fixture.project)) rmSync(path, { force: true });
  });

  test('the rail says which column each card it names is in', async ({ page, request }) => {
    const id = await projectId(request);
    fixture = await writeFixture(request, id);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openReport(page, id, FIXTURE);

    const link = page.getByTestId('report-link-question-card').first();
    await expect(link).toHaveAttribute('data-card-id', fixture.card);
    await expect(link).toHaveAttribute('data-card-column', fixture.column);
    await expect(link.getByTestId('report-link-column')).toHaveText(fixture.column);
  });

  test('a report with a question waiting opens on the question', async ({ page, request }) => {
    const id = await projectId(request);
    fixture = await writeFixture(request, id);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openReport(page, id, FIXTURE);

    // The ask is why the manager was handed the link, so the report opens
    // there rather than on its own title.
    const asks = page.locator('[data-part-kind="action"]');
    await expect(asks).toBeVisible();
    await expect
      .poll(async () => (await asks.boundingBox())?.y ?? 0, {
        message: 'the report opened on its title, not on the question',
        timeout: 10_000,
      })
      .toBeLessThan(220);
    const scrolled = await page.getByTestId('report-pane').evaluate((el) => el.scrollTop);
    expect(scrolled, 'nothing scrolled, so the question was never sought out').toBeGreaterThan(0);
  });

  test('a link that names one section lands on that section', async ({ page, request }) => {
    const id = await projectId(request);
    fixture = await writeFixture(request, id);
    await page.setViewportSize({ width: 1440, height: 900 });

    const facts = (await (
      await request.get(
        `${api()}/api/reports/spec?project=${fixture.project}&slug=${FIXTURE}` +
          `&path=${encodeURIComponent(fixture.dir)}`,
      )
    ).json()) as { content: { id: string; label: string }[] };
    const last = facts.content[facts.content.length - 1];

    await page.goto(`/project?id=${id}&tab=reports&report=${FIXTURE}&section=${last.id}`);
    await expect(page.getByTestId('report-part').first()).toBeVisible({ timeout: 90_000 });

    const pane = await box(page, 'report-pane');
    await expect
      .poll(async () => (await page.locator(`#${last.id}`).boundingBox())?.y ?? 0, {
        message: `the address named ${last.id} and the report stayed where it was`,
        timeout: 10_000,
      })
      .toBeLessThan(pane.y + 60);
  });
});
