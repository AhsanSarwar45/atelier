/**
 * What the chat's right rail draws, and in what order (bw-pl2v).
 *
 * Two things, on one chat, because they are one reading: the cards this chat
 * has touched are drawn ABOVE the agents it sent off, and the agents section
 * lists only what is still going until the reader asks for the rest.
 *
 * They belong together because they fix the same complaint. The agents used to
 * be first on the grounds that they are the part of the rail that moves — but
 * they are also the part that grows without a ceiling, so a long session drew a
 * wall of finished helpers and pushed the cards off the bottom. Cards go first
 * because wrapped chips are a few lines whatever the session has done, and the
 * finished helpers go behind one control that names how many there are.
 *
 * Written, not run: this needs one helper still going and one that has stopped,
 * in the same rail, at the same moment. A live run would have to start a real
 * agent and stop it to reach that pair, and what is under test here is the
 * drawing rather than the driving. The record and the agent's own file are
 * moved the way the kit moves them, so the running row is a row whose answer
 * genuinely has not arrived yet, not one a mock declared to be running.
 *
 * "Stopped" here is the reader's word for *no longer running*. The split the
 * rail makes is `isOver` (protocol.ts) — `done`, `failed` and `stopped` alike —
 * and the written record ends a helper as `done`, which is one of the three.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/chat-sidebar-sections.spec.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { makeFixtureProject, PARENT_CARD } from './fixture-board';
import { HELPER_AGENT, writeChatWithHelper } from './fixture-record';

/** Where a run leaves its proof. */
const SHOTS = 'tests/results';

/** Opening a chat off the disk is a file read plus a wake. */
const HELLO_MS = 120_000;

/** The states that mean a piece of sent-off work is over (protocol.ts). */
const OVER = ['done', 'failed', 'stopped'];

/** A folder of this case's own, so it never reads anybody's real work. */
const RUN = join(__dirname, '..', '.workbench-run-sections');
const PROJECT = join(RUN, 'project');

/**
 * A project of this run's own, marked as a test project so it stays off the
 * owner's dashboard. Asked for rather than made outright, because a project at
 * a path that already has one is refused.
 */
async function projectAt(request: APIRequestContext, path: string): Promise<{ id: string; path: string }> {
  const there = async (): Promise<{ id: string; path: string } | undefined> => {
    const listed = (await (await request.get('/api/projects?include_test=true')).json()) as {
      id: string;
      path: string;
    }[];
    return listed.find((p) => p.path === path);
  };
  const found = await there();
  if (found) return found;
  const made = await request.post('/api/projects', { data: { name: 'workbench-sections', path, isTest: true } });
  if (made.status() === 201) return (await made.json()) as { id: string; path: string };
  const said = await made.text();
  const raced = await there();
  expect(raced, `no project at ${path}, and it could not be made: ${said}`).toBeTruthy();
  return raced!;
}

test.describe('the sections of a chat’s right rail', () => {
  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    rmSync(RUN, { recursive: true, force: true });
    mkdirSync(RUN, { recursive: true });
  });
  test.describe.configure({ timeout: 300_000 });

  /**
   * A test project is left off the plain list, which is the list the project
   * page itself reads — so this page asks for them too, and a real visitor
   * typing the same address still sees none.
   */
  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
  });

  test('draws the cards above the helpers, and keeps the finished helper behind a control', async ({
    page,
    request,
  }) => {
    // The rail is a column beside the conversation on a screen with room for it.
    await page.setViewportSize({ width: 1440, height: 900 });
    makeFixtureProject(PROJECT, join(RUN, 'reporting'));
    const project = await projectAt(request, PROJECT);
    // One helper already finished, and a card only that helper touched — so a
    // chip for it on the rail can have come from nowhere else.
    const written = writeChatWithHelper({
      cwd: PROJECT,
      sessionId: randomUUID(),
      card: PARENT_CARD,
      sentOff: 1,
    });

    try {
      await page.goto(`/project?id=${project.id}&tab=chat`);
      await expect(page.getByTestId('chat-sidebar')).toBeVisible({ timeout: HELLO_MS });
      const listed = page.locator(`[data-testid="restore-row"][data-external-id="${written.sessionId}"]`);
      await listed.waitFor({ timeout: HELLO_MS });
      await listed.getByTestId('row-name').click();
      await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });

      const rail = page.locator('[data-testid="chat-right-rail"]');
      await expect(rail, 'the rail was not drawn beside the conversation').toHaveAttribute('data-open', 'true');

      // ---- the pair this case needs: one over, one still going --------------
      const over = page.locator(`[data-testid="sent-away-row"][data-agent="${HELPER_AGENT}"]`);
      await expect(over, 'the chat drew no row for the helper it had finished with').toHaveCount(1, {
        timeout: HELLO_MS,
      });
      await expect(over).toHaveAttribute('data-state', 'done');

      // And one sent off now, whose answer has not come back — which is the
      // shape a record ends in while an agent is working.
      const sent = written.sendsOff('Count the rows');
      const going = page.locator(`[data-testid="sent-away-row"][data-agent="${sent.agentId}"]`);
      await expect(going, 'the chat grew no row for the agent it sent off').toHaveCount(1, { timeout: HELLO_MS });
      expect(OVER, 'the row was over before its answer reached the chat').not.toContain(
        await going.getAttribute('data-state'),
      );
      await expect
        .poll(async () => page.getByTestId('sent-away-panel').getAttribute('data-running'), {
          message: 'the rail never settled on one running helper',
          timeout: HELLO_MS,
        })
        .toBe('1');
      await expect(page.getByTestId('sent-away-panel')).toHaveAttribute('data-finished', '1');

      // ---- the cards are drawn above the helpers ---------------------------
      await expect(
        page.locator(`[data-testid="bead-chip"][data-bead-id="${PARENT_CARD}"]`).first(),
        'no chip for the card the helper touched',
      ).toBeVisible({ timeout: HELLO_MS });

      // The words as they are written, not as the stylesheet shouts them: these
      // headings are drawn `uppercase`, and innerText would hand back the shout.
      expect(
        await page.getByTestId('chat-right-rail-body').locator('h3').allTextContents(),
        'the rail’s sections are not in the order the reader is promised',
      ).toEqual(['Related cards', 'Subagents']);

      // Said twice, because a heading above a panel is not the same claim as
      // the panel being above the other panel: in the words, and on the glass.
      const laidOut = await page.evaluate(() => {
        const cards = document.querySelector('[data-testid="rail-cards"]');
        const helpers = document.querySelector('[data-testid="sent-away-panel"]');
        return {
          drawn: Boolean(cards && helpers),
          cardsFirst: Boolean(
            cards && helpers && cards.compareDocumentPosition(helpers) & Node.DOCUMENT_POSITION_FOLLOWING,
          ),
          cardsBottom: cards?.getBoundingClientRect().bottom ?? 0,
          helpersTop: helpers?.getBoundingClientRect().top ?? 0,
        };
      });
      expect(laidOut.drawn, 'the rail drew no cards, or no helpers').toBe(true);
      expect(laidOut.cardsFirst, 'the helpers come before the cards in the rail').toBe(true);
      expect(
        laidOut.cardsBottom,
        `the cards end at ${laidOut.cardsBottom}px and the helpers start at ${laidOut.helpersTop}px`,
      ).toBeLessThanOrEqual(laidOut.helpersTop);

      // ---- at rest, only what is still going -------------------------------
      const stopped = page.getByTestId('sent-away-stopped');
      const control = page.getByTestId('toggle-stopped-agents');

      await expect(going, 'the helper still working is not on the rail').toBeVisible();
      await expect(
        page.getByTestId('sent-away-running').locator('[data-testid="sent-away-row"]'),
        'the running group holds something other than the one still going',
      ).toHaveCount(1);
      await expect(over, 'the finished helper is listed before anyone asked for it').toBeHidden();
      await expect(stopped).toBeHidden();
      await expect(control, 'the control does not say how many are behind it').toHaveText(
        /Show 1 completed/,
      );
      await expect(control).toHaveAttribute('aria-expanded', 'false');
      // The running rows are ABOVE the control, not under it.
      const controlTop = (await control.boundingBox())!.y;
      const goingTop = (await going.boundingBox())!.y;
      expect(goingTop, `the running helper is drawn at ${goingTop}px, below the control at ${controlTop}px`).toBeLessThan(
        controlTop,
      );
      await page.screenshot({ path: `${SHOTS}/chat-rail-sections-at-rest.png`, fullPage: false });

      // ---- one click brings the finished one out ---------------------------
      await control.click();
      await expect(stopped).toBeVisible();
      await expect(over, 'the finished helper stayed hidden after the control was clicked').toBeVisible();
      await expect(control).toHaveAttribute('aria-expanded', 'true');
      await expect(control).toHaveText(/Hide 1 completed/);
      await expect(going, 'opening the finished ones took the running one away').toBeVisible();
      await page.screenshot({ path: `${SHOTS}/chat-rail-sections-opened.png`, fullPage: false });

      // ---- and the next click puts it away again ---------------------------
      await control.click();
      await expect(over, 'the finished helper stayed on the rail after a second click').toBeHidden();
      await expect(stopped).toBeHidden();
      await expect(control).toHaveAttribute('aria-expanded', 'false');
      await expect(control).toHaveText(/Show 1 completed/);
      await expect(going).toBeVisible();
    } finally {
      written.remove();
      await request.delete(`/api/projects/${project.id}`);
    }
  });
});
