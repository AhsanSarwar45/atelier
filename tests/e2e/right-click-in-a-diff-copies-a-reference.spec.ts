import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { aChatSomebodyElseIsIn } from './fixture-held';
import { openGitView } from './open-git-view';

/**
 * Selecting lines in a diff and pressing copy copies the lines; a right-click
 * and "Copy reference" puts `@diff:path:+from-to` on the clipboard, which
 * pastes into the chat as a badge (bw-gr8y.8, bw-v79ny.2).
 *
 * The reason this has to be proved in a browser and not only in jsdom is that
 * it is a browser's own behaviour being taken over: a real Selection over real
 * table cells, a real Ctrl-C and right-click answered by our handlers rather
 * than by the browser's own, and a real clipboard, which is read back out
 * afterwards to see what is on it.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/right-click-in-a-diff-copies-a-reference.spec.ts
 */

/** Where a run leaves its proof; not the artifacts folder, which is emptied. */
const SHOTS = 'tests/results';

/** Opening a chat is a file read plus a wake; this is the whole way in. */
const WAY_IN_MS = 120_000;

/** Everything this case makes, in one folder it can delete whole. */
const FIXTURE = join(__dirname, '..', '.copy-a-reference-run');
const REPO = join(FIXTURE, 'repo');

/** git, run in a directory, answering with what it printed. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Who this repository's commits are by, and that they are not signed. */
function settle(repo: string): void {
  git(repo, 'config', '--local', 'user.name', 'Copy A Reference Fixture');
  git(repo, 'config', '--local', 'user.email', 'copy-a-reference@example.invalid');
  git(repo, 'config', '--local', 'commit.gpgsign', 'false');
  git(repo, 'config', '--local', 'core.hooksPath', join(FIXTURE, 'no-hooks'));
}

/** Twenty numbered lines, so that a line's number is readable in the picture. */
function twentyLines(): string {
  return `${Array.from({ length: 20 }, (_, at) => `const line${at + 1} = ${at + 1};`).join('\n')}\n`;
}

/**
 * A repository holding two files of twenty lines: one with its thirteenth line
 * rewritten, one with its twelfth and thirteenth taken out. The first is a
 * change with a new side to count by, the second has nothing but old numbers —
 * the two answers the card asks for, in one screen.
 */
function seedRepository(): void {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(FIXTURE, 'no-hooks'), { recursive: true });
  mkdirSync(join(REPO, 'src'), { recursive: true });

  git(REPO, 'init', '-b', 'main');
  settle(REPO);

  // The chat's bar — and with it the way into the Git rail — is drawn only for
  // a project that declares itself one of this app's own.
  mkdirSync(join(REPO, '.atelier'), { recursive: true });
  writeFileSync(
    join(REPO, '.atelier', 'project.toml'),
    [
      'schema_version = 1',
      '',
      '[project]',
      'display_name = "copy-a-reference"',
      'use_beads = true',
      '',
      '[git]',
      'completed_work_branch = "main"',
      '',
      '[beads]',
      'issue_id_prefix = "cr"',
      '',
    ].join('\n'),
  );
  writeFileSync(join(REPO, '.gitignore'), ['.beads/', '.worktrees/', 'node_modules/', ''].join('\n'));

  writeFileSync(join(REPO, 'src', 'a.ts'), twentyLines());
  writeFileSync(join(REPO, 'src', 'b.ts'), twentyLines());
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-m', 'twenty lines each');

  const lines = twentyLines().split('\n');
  // a.ts: the thirteenth line rewritten, so rows ten to sixteen are drawn and
  // every one of them carries a number on both sides.
  const rewritten = [...lines];
  rewritten[12] = 'const line13 = 1300;';
  writeFileSync(join(REPO, 'src', 'a.ts'), rewritten.join('\n'));
  // b.ts: the twelfth and thirteenth taken out, so those two rows have a number
  // on the left and nothing at all on the right.
  const shortened = [...lines];
  shortened.splice(11, 2);
  writeFileSync(join(REPO, 'src', 'b.ts'), shortened.join('\n'));
}

/** A project of this case's own, marked as a test project. */
async function fixtureProject(request: APIRequestContext): Promise<{ id: string; path: string }> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as {
    id: string;
    path: string;
  }[];
  const had = listed.find((p) => p.path === REPO);
  if (had) return had;
  const made = await request.post('/api/projects', {
    data: { name: 'copy-a-reference', path: REPO, isTest: true },
  });
  expect(made.status(), `could not make a project: ${await made.text()}`).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

test.describe('copying out of the git diff', () => {
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    seedRepository();
  });

  test.afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  test('Ctrl-C copies the lines, and a right-click copies @diff:path:+from-to', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });

    const project = await fixtureProject(request);
    const chat = aChatSomebodyElseIsIn(REPO, 'Show me what you changed');

    try {
      const listed = page.waitForResponse((r) => r.url().includes('/api/workbench/restore') && r.ok(), {
        timeout: WAY_IN_MS,
      });
      await page.goto(`/project?id=${project.id}&tab=chat`);
      await listed;
      const row = page.locator(`[data-testid="restore-row"][data-external-id="${chat.id}"]`);
      await row.waitFor({ timeout: WAY_IN_MS });
      await row.getByTestId('row-name').click();
      await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });

      await openGitView(page);
      await page.getByTestId('git-diff-toggle').click();
      await expect(page.getByTestId('git-diff-view')).toBeVisible({ timeout: 60_000 });

      const section = (path: string) => page.locator(`[data-testid="git-diff-file"][data-path="${path}"]`);
      const table = section('src/a.ts').getByTestId('diff-table');
      await expect(table).toBeVisible({ timeout: 60_000 });

      /**
       * Take the reader's own selection over a run of rows, down the column he
       * would be reading — the new side of a rewrite, the old side of a
       * deletion, where the other side of the row is empty.
       *
       * The selection is made through the DOM rather than by dragging the
       * mouse: a synthetic drag does not move the caret in headless Chromium,
       * and dragging is the browser's business anyway. What has to be real
       * here, and is, is the Selection the browser ends up holding and the
       * copy that the keyboard then fires at it.
       */
      const select = async (which: ReturnType<typeof section>, column: 'left' | 'right', from: number, to: number) => {
        await which.getByTestId('diff-table').evaluate(
          (node, where) => {
            const rows = [...node.querySelectorAll('tr')];
            const cell = (row: Element) => row.querySelectorAll('td')[where.column === 'left' ? 1 : 3]!;
            const last = cell(rows[where.to]!);
            const range = document.createRange();
            range.setStart(cell(rows[where.from]!), 0);
            range.setEnd(last, last.childNodes.length);
            const selection = window.getSelection()!;
            selection.removeAllRanges();
            selection.addRange(range);
          },
          { column, from, to },
        );
      };

      /** What the clipboard holds after the reader has pressed copy. */
      const copied = async (): Promise<string> => {
        await page.evaluate(() => navigator.clipboard.writeText('nothing has been copied yet'));
        await page.keyboard.press('ControlOrMeta+c');
        return page.evaluate(() => navigator.clipboard.readText());
      };

      // Rows three to five of this file's diff are its lines twelve to
      // fourteen: the row before the rewrite, the rewrite, and the row after.
      await select(section('src/a.ts'), 'right', 2, 4);
      await expect
        .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
        .not.toBe('');

      // Ctrl-C copies the lines of the side that was selected.
      expect(await copied(), 'Ctrl-C did not copy the lines themselves').toBe(
        'const line12 = 12;\nconst line13 = 1300;\nconst line14 = 14;',
      );

      /** What the clipboard holds after a right-click and the menu item `item`. */
      const fromMenu = async (which: ReturnType<typeof section>, column: 'left' | 'right', row: number, item: string) => {
        await page.evaluate(() => navigator.clipboard.writeText('nothing has been copied yet'));
        await which
          .getByTestId('diff-table')
          .locator('tr')
          .nth(row)
          .locator('td')
          .nth(column === 'left' ? 1 : 3)
          .click({ button: 'right' });
        await expect(page.getByTestId('diff-menu')).toBeVisible();
        await page.getByTestId(item).click();
        return page.evaluate(() => navigator.clipboard.readText());
      };

      await select(section('src/a.ts'), 'right', 2, 4);
      await section('src/a.ts').getByTestId('diff-table').locator('tr').nth(3).locator('td').nth(3).click({ button: 'right' });
      await expect(page.getByTestId('diff-menu')).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/bw-v79ny2-diff-menu.png` });
      await page.keyboard.press('Escape');
      expect(
        await fromMenu(section('src/a.ts'), 'right', 3, 'diff-menu-copy-reference'),
        'Copy reference over the new side did not name the diff lines',
      ).toBe('@diff:src/a.ts:+12-14');

      // A selection over nothing but removed lines is counted the old way,
      // because those lines are not in the new file to be counted the new way.
      const gone = section('src/b.ts');
      await expect(gone.getByTestId('diff-table')).toBeVisible();
      await select(gone, 'left', 3, 4);
      expect(
        await fromMenu(gone, 'left', 3, 'diff-menu-copy-reference'),
        'Copy reference over removed lines did not use the old numbers',
      ).toBe('@diff:src/b.ts:-12-13');

      // Pasted into the chat, the reference is a badge.
      const writing = page.getByTestId('composer-frame').locator('.cm-content');
      await writing.click();
      await page.keyboard.press('ControlOrMeta+v');
      await page.keyboard.type(' — why?');
      const badge = page.getByTestId('composer-reference');
      await expect(badge).toHaveCount(1);
      await expect(badge).toHaveAttribute('data-reference-id', 'src/b.ts:-12-13');
      await expect(badge).toContainText('b.ts −12-13');
    } finally {
      chat.forget();
      await request.delete(`/api/projects/${project.id}`);
    }
  });
});
