import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { backend, command, openChatTab } from './fixture-held';

/**
 * Closing a chat, on a real stack.
 *
 * The app had no way to close one at all: the only control that looked like it
 * was Stop, which cuts the answer in flight and leaves the agent standing. The
 * manager's ruling, 2026-08-25: the control belongs on each row of the list,
 * because closing chats is tidying and tidying is done over a list. And
 * 2026-08-26: closing one is closing the terminal it ran in — the agent goes,
 * the chat falls asleep like any other sleeping chat, and the conversation is
 * still there to open.
 *
 * What only a real stack can prove, and the unit suites cannot: that the row
 * survives a reload, which means it came back that way from the server rather
 * than from a screen holding its own opinion; that the sidecar has really let
 * the agent go, which is a live process being torn down; and how wide the name
 * on a row actually is, which is a measurement and needs a browser that lays
 * things out.
 *
 * Every case works in a project of its own and takes it away again, so it never
 * closes a chat of the owner's.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/chat-close.spec.ts
 */

/** Starting an agent is a process launch. */
const HELLO_MS = 120_000;

/** Where a run that has to make its own project puts it, same as the fixture's. */
const OWN_PROJECT_DIR = join(__dirname, '..', '.held-run');

/**
 * A project of this case's own, and how to take it away again.
 *
 * The cases run side by side against one instance and each stands up chats that
 * land on the same list, so a case that borrowed the project next door would be
 * asserting about rows another case is at that moment ending.
 *
 * Made here rather than by the fixture's own helper, which marks its project
 * `isTest`: such a project is invisible to `GET /api/projects`, which is the
 * only list the project screen reads, so the screen draws "This project could
 * not be read" and no case that navigates to one can do anything at all
 * (bw-1cqk). Everything here happens on the screen, so it needs one the screen
 * can open. The folder is the fixture's, so the runner's own sweep for projects
 * left behind still finds this one.
 */
async function aProjectToWorkIn(request: APIRequestContext, what: string) {
  const dir = join(OWN_PROJECT_DIR, `${what}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  const made = await request.post(`${backend()}/api/projects`, { data: { name: `held-${what}`, path: dir } });
  expect(made.status(), `could not make a project: ${await made.text()}`).toBe(201);
  const project = (await made.json()) as { id: string; path: string };
  return {
    ...project,
    async remove() {
      await request.delete(`${backend()}/api/projects/${project.id}`);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * The chat this case will close: started, spoken to once, and opened on the
 * screen.
 *
 * Spoken to because a chat with nothing ever said in it is deliberately left
 * out of the list (registry.ts, docs/agent-workbench.md §6.3.1) — it is a chat
 * that opened and was never typed into, and offering it back would fill the
 * list with empties. Every case here is about a ROW, so the chat has to be one:
 * one turn gives it a title and a message, which is what makes it an offer. The
 * answer is not waited for; sending publishes the turn before the agent says
 * anything back.
 */
async function aChatToClose(request: APIRequestContext, page: Page, project: { id: string; path: string }) {
  const { ok, body, said } = await command(request, {
    type: 'session.start',
    projectId: project.id,
    projectPath: project.path,
    brand: 'claude',
  });
  expect(ok, `could not start a chat: ${body}`).toBe(true);
  const id = said.id!;

  const spoke = await command(request, {
    type: 'prompt.send',
    sessionId: id,
    text: 'Reply with the single word OK and nothing else.',
  });
  expect(spoke.ok, `could not speak to the chat: ${spoke.body}`).toBe(true);

  // Opened on the screen, which is where a person closes one from.
  await page.goto(`/project?id=${project.id}&tab=chat&chat=${id}`);
  await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
  return id;
}

/**
 * That chat's own row, waited for on the list the sidebar just fetched.
 *
 * Waited for by id rather than taken from the first row that draws: a row can
 * also arrive from the live stream, carrying whatever that stream last said —
 * which is how a chat can sit there reading `starting` long after it has been
 * closed.
 */
async function theRowFor(page: Page, project: { id: string; path: string }, id: string) {
  await openChatTab(page, project);
  const row = page.locator(`[data-testid="restore-row"][data-row-key="${id}"]`);
  await row.waitFor({ timeout: 60_000 });
  return row;
}

test.describe('closing a chat', () => {
  test.describe.configure({ timeout: 300_000 });

  test('is done from its row, and the chat falls asleep', async ({ page, request }) => {
    const project = await aProjectToWorkIn(request, 'closing');
    try {
      const id = await aChatToClose(request, page, project);

      const row = await theRowFor(page, project, id);
      // Kept off the rail until the reader is on the row, the same as the pill.
      await row.hover();
      await row.getByTestId('row-close').click();

      await expect.poll(async () => row.getAttribute('data-state'), { timeout: 60_000 }).toBe('dormant');
      // And it says nothing about it, because there is nothing to say that the
      // rest of the sleeping list is not already saying (the manager,
      // 2026-08-26). A word here would claim a difference this app does not
      // have: both kinds of row have no agent, and a click wakes either.
      await page.mouse.move(0, 0);
      await expect(row.getByTestId('row-pill'), 'a closed chat wore a word no other sleeping chat wears').toHaveCount(
        0,
        { timeout: 30_000 },
      );
    } finally {
      await project.remove();
    }
  });

  test('and the control costs the name none of its line', async ({ page, request }) => {
    // The manager sent the first build back for this, 2026-08-26: the control
    // stood in the row's own line, so it held a width and a gap whether the
    // pointer was there or not, and every name in the list was cut short to
    // reserve room for a button nobody could see.
    //
    // Measured against the row next door, which has no control at all — that is
    // what "none of its line" means, and it is a number a browser has to lay
    // out. Both rows are the same width, so their names differ only by whatever
    // the control takes.
    const project = await aProjectToWorkIn(request, 'width');
    try {
      const closable = await aChatToClose(request, page, project);
      const plain = await aChatToClose(request, page, project);

      // The second one put to sleep, so it offers no control: the comparison
      // needs one row of each kind, side by side in one list.
      const plainRow = await theRowFor(page, project, plain);
      await plainRow.hover();
      await plainRow.getByTestId('row-close').click();
      await expect.poll(async () => plainRow.getAttribute('data-state'), { timeout: 60_000 }).toBe('dormant');
      await expect(plainRow.getByTestId('row-close')).toHaveCount(0, { timeout: 30_000 });

      const row = page.locator(`[data-testid="restore-row"][data-row-key="${closable}"]`);
      await expect(row.getByTestId('row-close'), 'the case needs one row that does offer it').toHaveCount(1);

      const widthOf = async (which: typeof row) => (await which.getByTestId('row-name').boundingBox())!.width;

      await page.mouse.move(0, 0);
      const withControl = await widthOf(row);
      const without = await widthOf(plainRow);
      expect(withControl, 'the name is cut short to reserve room for a hidden control').toBeCloseTo(without, 0);

      // And nothing moves when the pointer arrives, which is the other half of
      // drawing it over the clock rather than beside it.
      await row.hover();
      await expect(row.getByTestId('row-close')).toBeVisible();
      expect(await widthOf(row), 'the row reflowed under the pointer').toBeCloseTo(withControl, 0);
    } finally {
      await project.remove();
    }
  });

  test('takes the agent away, where Stop only cuts the answer', async ({ page, request }) => {
    const project = await aProjectToWorkIn(request, 'letting-go');
    try {
      const id = await aChatToClose(request, page, project);

      // While it is running, the sidecar will steer it.
      const before = await command(request, { type: 'session.stop', sessionId: id });
      expect(before.ok, `a running chat refused Stop: ${before.body}`).toBe(true);

      const row = await theRowFor(page, project, id);
      await row.hover();
      await row.getByTestId('row-close').click();
      await expect.poll(async () => row.getAttribute('data-state'), { timeout: 60_000 }).toBe('dormant');

      // And now there is nothing of ours left holding it. This is the whole
      // difference between the two controls, and it is a real process.
      await expect
        .poll(async () => (await command(request, { type: 'session.stop', sessionId: id })).ok, { timeout: 30_000 })
        .toBe(false);
    } finally {
      await project.remove();
    }
  });

  test('and the chat is kept: it survives a reload and opens again', async ({ page, request }) => {
    const project = await aProjectToWorkIn(request, 'keeping');
    try {
      const id = await aChatToClose(request, page, project);

      const row = await theRowFor(page, project, id);
      await row.hover();
      await row.getByTestId('row-close').click();
      await expect.poll(async () => row.getAttribute('data-state'), { timeout: 60_000 }).toBe('dormant');

      // Nothing was deleted and nothing was hidden. A fresh load is the honest
      // question, because it asks the server rather than the screen that just
      // did the closing.
      await openChatTab(page, project);
      const again = page.locator(`[data-testid="restore-row"][data-row-key="${id}"]`);
      await expect(again, 'the chat was gone from the list after a reload').toHaveCount(1, { timeout: 60_000 });
      await expect(again).toHaveAttribute('data-state', 'dormant');

      // Readable, which is what keeping it was for: it opens on a click like
      // any sleeping chat.
      await again.getByTestId('row-name').click();
      await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });

      // And it is not offered a second closing, because there is no longer an
      // agent for one to take away.
      await openChatTab(page, project);
      await expect(
        page.locator(`[data-testid="restore-row"][data-row-key="${id}"]`).getByTestId('row-close'),
        'a sleeping chat still offers to be closed',
      ).toHaveCount(0, { timeout: 30_000 });
    } finally {
      await project.remove();
    }
  });
});
