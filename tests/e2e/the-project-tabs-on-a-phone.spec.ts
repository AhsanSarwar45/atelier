import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { bd } from './fixture-board';

/**
 * The project tab bar read on a phone (bw-4kp0.1).
 *
 * The tab bar carries Chat, Board and Files and then, on the same row, whatever
 * tools the open tab hands it — the board alone has eleven. At 390px the three
 * words are the first thing to spend that row's width, and what they push off
 * it is the tools. So below the `sm` breakpoint each tab is drawn as its icon
 * alone.
 *
 * An icon-only tab is only an improvement if it is still a tab: it has to keep
 * the name a screen reader reads out, and it has to keep a target a thumb can
 * hit. Both are measured here rather than assumed, alongside the word being
 * gone. Then the same bar at 1024px, where the words are the right answer and
 * must be exactly what they always were.
 *
 * Run: PHONE_TABS_STAGE=before scripts/workbench-e2e.sh tests/e2e/the-project-tabs-on-a-phone.spec.ts
 */

const STAGE = process.env.PHONE_TABS_STAGE ?? 'now';
const SHOTS = `tests/results/project-tabs-phone/${STAGE}`;
const WAIT = 60_000;

/** A modern phone in the hand, as Playwright's own iPhone 14 preset has it. */
const PHONE = { width: 390, height: 844 };

/** The long-standing floor for a target a thumb has to hit. */
const THUMB = 44;

/** The three tabs, each with the word it is drawn as on a wide screen. */
const TABS = [
  { testid: 'tab-chat', word: 'Chat' },
  { testid: 'tab-board', word: 'Board' },
  { testid: 'tab-files', word: 'Files' },
];

test.use({ viewport: PHONE, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

const measured: string[] = [];
function note(what: string): void {
  measured.push(what);
  console.log(what);
}

function git(where: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: where, stdio: 'pipe' });
}

/**
 * A project the Board tab is really drawn for: the app only offers Board when
 * the manifest says the project keeps cards, so a fixture without one would
 * measure two tabs and call it three.
 */
function seed(where: string): void {
  rmSync(where, { recursive: true, force: true });
  mkdirSync(join(where, 'src'), { recursive: true });
  writeFileSync(join(where, 'README.md'), '# the project tabs on a phone\n');
  writeFileSync(join(where, 'src', 'main.ts'), 'export const main = 1;\n');

  git(where, 'init', '-q', '-b', 'main', '.');
  git(where, 'config', 'user.name', 'The Project Tabs On A Phone');
  git(where, 'config', 'user.email', 'the-project-tabs-on-a-phone@atelier.test');
  git(where, 'config', 'commit.gpgsign', 'false');
  git(where, 'add', '-A');
  git(where, 'commit', '-qm', 'seed');

  bd(['init', '--prefix', 'pt'], where);
  mkdirSync(join(where, '.atelier'), { recursive: true });
  writeFileSync(
    join(where, '.atelier', 'project.toml'),
    [
      'schema_version = 1',
      '',
      '[project]',
      'display_name = "the-project-tabs-on-a-phone"',
      'use_beads = true',
      'summary = ""',
      '',
      '[git]',
      'completed_work_branch = "main"',
      '',
      '[beads]',
      'issue_id_prefix = "pt"',
      '',
    ].join('\n'),
  );
  const cards = [
    { id: 'pt-1', title: 'Something still waiting', status: 'open', issue_type: 'task', priority: 1 },
    { id: 'pt-2', title: 'Something under way', status: 'in_progress', issue_type: 'task', priority: 1 },
  ];
  writeFileSync(join(where, 'seed.jsonl'), cards.map((one) => JSON.stringify(one)).join('\n') + '\n');
  bd(['import', '--input', 'seed.jsonl'], where);
}

async function fixtureProject(request: APIRequestContext, name: string, path: string) {
  const made = await request.post('/api/projects', { data: { name, path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

/** What one tab really is on the screen: its word, its name, and its target. */
async function readTab(page: Page, testid: string) {
  return page.getByTestId(testid).evaluate((el) => {
    const box = el.getBoundingClientRect();
    return {
      shown: (el as HTMLElement).innerText.trim(),
      name: el.getAttribute('aria-label') ?? (el as HTMLElement).innerText.trim(),
      width: Math.round(box.width),
      height: Math.round(box.height),
      icons: el.querySelectorAll('svg').length,
    };
  });
}

test('the project tabs are icons on a phone and words on a wide screen', async ({ page, request }) => {
  test.setTimeout(300_000);
  const fixture = join(__dirname, '..', '.workbench-run-project-tabs-phone');
  seed(fixture);

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });

  const project = await fixtureProject(request, 'the-project-tabs-on-a-phone', fixture);
  mkdirSync(SHOTS, { recursive: true });

  // ---- 1. The bar at 390px, where the words are what is in the way. ------
  await page.goto(`/project?id=${project.id}&tab=board`);
  await page.getByTestId('project-tabs').waitFor({ timeout: WAIT });
  await page.getByTestId('board-scroll').waitFor({ timeout: WAIT });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOTS}/phone.png`, animations: 'disabled' });

  const onPhone = [];
  for (const tab of TABS) {
    const seen = await readTab(page, tab.testid);
    onPhone.push({ tab, seen });
    note(
      `   at 390px ${tab.testid} shows "${seen.shown}", is named "${seen.name}", ` +
        `draws ${seen.icons} icon(s) and is ${seen.width}x${seen.height}`,
    );
  }

  for (const { tab, seen } of onPhone) {
    // The fault itself: the word taking the row's width.
    expect(seen.shown, `${tab.testid} still spells out its word at 390px`).toBe('');
    // An icon-only tab is only a tab if it is still drawn and still named.
    expect(seen.icons, `${tab.testid} draws no icon at 390px`).toBeGreaterThan(0);
    expect(seen.name, `${tab.testid} lost the name a screen reader reads`).toBe(tab.word);
    expect(seen.width, `${tab.testid} is narrower than a thumb at 390px`).toBeGreaterThanOrEqual(THUMB);
  }

  // The row exists to be shared. With the words gone the three tabs together
  // must leave the greater part of a 390px row to the tools beside them.
  const spent = onPhone.reduce((total, one) => total + one.seen.width, 0);
  note(`   at 390px the three tabs together take ${spent}px of the ${PHONE.width}px row`);
  expect(spent, 'the three tabs still take most of the phone row').toBeLessThan(PHONE.width / 2);

  // ---- 2. The same bar at 1024px, which must not have changed. -----------
  await page.setViewportSize({ width: 1024, height: 844 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${SHOTS}/wide.png`, animations: 'disabled' });

  for (const tab of TABS) {
    const seen = await readTab(page, tab.testid);
    note(`   at 1024px ${tab.testid} shows "${seen.shown}" and is ${seen.width}x${seen.height}`);
    expect(seen.shown, `${tab.testid} lost its word on a wide screen`).toBe(tab.word);
  }

  writeFileSync(`${SHOTS}/measurements.txt`, measured.join('\n') + '\n');
});
