import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * A press on the manager's sign-off is answered at once (bw-x1fv.8).
 *
 * Finishing a job runs the board program, and on this machine that is a second
 * or so while it is quiet and was measured at 35 seconds while other agents
 * were writing to the board. All the press did until now was grey a small
 * button and swap its word, so the manager pressed, saw a screen that looked
 * unchanged, and pressed again.
 *
 * What is proved here is the two ends of that wait on a real screen: the sign
 * that the press was heard is up inside three tenths of a second, and the card
 * leaves the manager's column when the board itself answers — not before, so
 * the screen never claims something the board has not agreed to.
 *
 * The board is built for the run: its own directory, its own beads database,
 * one job standing in the manager's column with every piece of it finished.
 * Needs an instance built from THIS worktree.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/signoff-press.spec.ts
 */

const PROJECT_NAME = 'signoffdemo';
const RUN_DIR = join(__dirname, '..', '.signoff-press-run');
const PROJECT_DIR = join(RUN_DIR, PROJECT_NAME);

/** The job he signs off, and the column it stands in. */
const JOB = 'press-m';
const MANAGER = 'manager_review';
/** How long a press may sit unanswered before it reads as a screen that did nothing. */
const HEARD_MS = 300;
/**
 * The board's own answer, held back for the run.
 *
 * A fixture board of one job closes in well under a second, and a press that is
 * answered before the assertion runs proves nothing about the wait this card is
 * about. So the close is held for five seconds — the same shape as the 35 the
 * manager saw, short enough to run — and everything about being heard is
 * asserted while the work is genuinely still out.
 */
const HELD_MS = 5_000;

const WHEN = '2026-08-19T09:00:00Z';

function bd(args: string[], cwd: string): string {
  return execFileSync('bd', args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 60_000 });
}

/** One finished piece of the job, hung off it the way the board hangs children. */
function piece(n: number): unknown {
  return {
    _type: 'issue',
    id: `${JOB}.${n}`,
    title: `A piece of the job`,
    description: '',
    status: 'closed',
    priority: 1,
    issue_type: 'task',
    owner: 'press',
    created_at: WHEN,
    updated_at: WHEN,
    closed_at: WHEN,
    labels: [],
    dependencies: [
      {
        issue_id: `${JOB}.${n}`,
        depends_on_id: JOB,
        type: 'parent-child',
        created_at: WHEN,
        created_by: 'press',
        metadata: '{}',
      },
    ],
  };
}

/**
 * A board of one finished job waiting on the manager.
 *
 * `manager_review` is a column this product added, so the database is told it
 * is a status before it will hold a card in it.
 */
function makeBoard(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  execFileSync('git', ['init', '-q', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'signoff test'], { cwd: dir, stdio: 'pipe' });

  bd(['init'], dir);
  bd(['config', 'set', 'status.custom', 'manager_review:wip,in_review:wip'], dir);

  const board = [
    {
      _type: 'issue',
      id: JOB,
      title: 'A job waiting for the manager',
      description: '',
      status: MANAGER,
      priority: 1,
      issue_type: 'epic',
      owner: 'press',
      created_at: WHEN,
      updated_at: WHEN,
      labels: [],
      dependencies: [],
    },
    piece(1),
    piece(2),
  ];
  const path = join(dir, 'board.jsonl');
  writeFileSync(path, board.map((rec) => JSON.stringify(rec)).join('\n') + '\n');
  bd(['import', path], dir);
}

/**
 * What the board says about the job now, whatever the screen is showing.
 *
 * Asked for without stopping the run: reading the board takes a program of its
 * own, and how long it takes depends on what else on this machine is writing to
 * a board at that moment. Waited for the blocking way, a slow read freezes
 * everything this file is watching for — which is how a notice that came and
 * went during one of these reads was recorded as a notice that never came.
 */
const runProgram = promisify(execFile);
async function statusOf(dir: string): Promise<string> {
  const { stdout } = await runProgram('bd', ['show', JOB, '--json'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const said = JSON.parse(stdout) as { id: string; status?: string }[];
  return said.find((card) => card.id === JOB)?.status ?? '';
}

/**
 * Every word the screen has said in a notice since this was switched on.
 *
 * A notice says its piece for about five seconds and then takes itself away, so
 * looking for one is a race against its own clock: ask a moment too late and a
 * notice that did appear reads as one that never did. This keeps a written
 * record of them instead, so what is asserted is what the screen said, not what
 * it happened to still be saying.
 */
async function keepEveryNotice(page: Page): Promise<void> {
  await page.evaluate(() => {
    const said: string[] = [];
    (window as unknown as { __noticesSaid: string[] }).__noticesSaid = said;
    const read = () => {
      // A notice is a list item the moment it is drawn; it is also read out
      // separately for a screen reader, and the same words arriving twice are
      // written down once.
      for (const notice of Array.from(document.querySelectorAll('li[data-state], [role="status"]'))) {
        const words = (notice.textContent ?? '').trim();
        if (words && !said.includes(words)) said.push(words);
      }
    };
    new MutationObserver(read).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    read();
  });
}

const noticesSaid = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __noticesSaid?: string[] }).__noticesSaid ?? []);

/**
 * The fixture on the app's own project list, marked `isTest` so it stays off
 * the owner's real dashboard and is swept up by teardown.
 */
async function projectAt(request: APIRequestContext, path: string): Promise<{ id: string }> {
  const existing = (await (await request.get('/api/projects?include_test=true')).json()) as {
    id: string;
    path: string;
  }[];
  const found = existing.find((p) => p.path === path);
  if (found) return found;
  const created = await request.post('/api/projects', { data: { name: PROJECT_NAME, path, isTest: true } });
  expect(created.status(), await created.text()).toBe(201);
  return (await created.json()) as { id: string };
}

const cardIn = (page: Page, column: string) =>
  page.locator(`[data-column="${column}"] [data-bead-id="${JOB}"]`);

test.describe("the manager's sign-off", () => {
  /**
   * A fixture project is `isTest`, which keeps it off the real dashboard — and
   * would keep it out of its own tab too, so this page asks for test projects
   * as well. Scoped to this page: a real visitor still sees none of them.
   */
  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
  });

  test('says it was heard at once, and moves the card when the board answers', async ({ page, request }) => {
    test.setTimeout(240_000);

    makeBoard(PROJECT_DIR);
    const project = await projectAt(request, PROJECT_DIR);

    try {
      await page.goto(`/project?id=${project.id}`);
      const card = cardIn(page, MANAGER);
      await expect(card, 'the fixture job never reached the manager’s column').toBeVisible({ timeout: 60_000 });

      const finish = card.getByRole('button', { name: /mark done/i });
      await expect(finish).toBeVisible({ timeout: 30_000 });
      expect(await statusOf(PROJECT_DIR)).toBe(MANAGER);

      await keepEveryNotice(page);

      // The board's answer is held back, so what follows is asserted while the
      // work behind the press is still out.
      await page.route('**/api/bd/command', async (route) => {
        const asked = route.request().postDataJSON() as { args?: string[] } | null;
        if (asked?.args?.[0] === 'close') await new Promise((r) => setTimeout(r, HELD_MS));
        await route.continue();
      });

      const pressed = Date.now();
      await finish.click();

      // ---- heard, before the board has answered ---------------------------
      // The card is the sign that has to be immediate: it says, on the job
      // itself, that this press is the one being worked on. Both of its halves
      // land in the same redraw — the word in the button and the mark on the
      // card — so either one is the same measurement.
      await expect(card, 'the press sat silent past three tenths of a second')
        .toHaveAttribute('data-marking', 'true', { timeout: HEARD_MS });
      await expect(card.getByRole('button', { name: /marking/i })).toBeVisible({ timeout: HEARD_MS });
      const heard = Date.now() - pressed;

      // The notice is the loud half and comes through a portal of its own, so
      // it is given room to slide in — still an order below the wait it is
      // covering for.
      await expect(page.getByText(/marking .* done/i), 'nothing said a press had landed')
        .toBeVisible({ timeout: 2_000 });
      const told = Date.now() - pressed;
      // eslint-disable-next-line no-console
      console.log(`heard on the card in ${heard}ms, said in words in ${told}ms, against a wait of ${HELD_MS}ms`);

      // ---- and still standing where the board left it ---------------------
      // Said, not moved: a card that jumped to Done on the press would be
      // telling him something the board has not agreed to.
      expect(await statusOf(PROJECT_DIR)).toBe(MANAGER);
      await expect(cardIn(page, MANAGER)).toBeVisible();

      // ---- answered, and then moved ---------------------------------------
      // Read off the record of what was said rather than off the screen as it
      // is now: the notice is up for a few seconds and the card leaves the
      // column on the board's own next reading, which is the slower of the two,
      // so by the time the card has gone the words are long gone with it.
      await expect
        .poll(() => noticesSaid(page), {
          message: 'nothing said the sign-off had gone through',
          timeout: 60_000,
        })
        .toEqual(expect.arrayContaining([expect.stringMatching(/is done/i)]));
      await expect(cardIn(page, MANAGER), 'the card sat in the manager’s column after it was signed off')
        .toHaveCount(0, { timeout: 120_000 });
      expect(await statusOf(PROJECT_DIR), 'the screen moved the card without the board agreeing').toBe('closed');
    } finally {
      await request.delete(`/api/projects/${project.id}`);
      rmSync(RUN_DIR, { recursive: true, force: true });
    }
  });
});
