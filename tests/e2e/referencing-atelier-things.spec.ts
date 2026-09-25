import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { PARENT_CARD, discardFixture, makeFixtureProject } from './fixture-board';

/**
 * A card, a chat or a skill is named in the composer with `@` and reaches the
 * agent described (bw-mi3s).
 *
 * - The `@` menu offers them beside the files, grouped by kind, and
 *   `@bead:`/`@chat:`/`@skill:` narrows it to one kind (bw-mi3s.4).
 * - A picked one is drawn as its badge in the composer, and the same badge in
 *   the sent message (bw-mi3s.1).
 * - A card or chat address pasted from the address bar becomes its reference
 *   (bw-mi3s.5).
 * - The agent is told what each reference is: the card's title, the chat's
 *   name with how to read it, the skill's instructions (bw-mi3s.2, bw-mi3s.3).
 *
 * Each case has its own fixture project, a real checkout with a real board,
 * thrown away afterwards. The case that sends needs a signed-in provider:
 *
 *   BEADS_E2E_LIVE_PROVIDERS=1 scripts/workbench-e2e.sh tests/e2e/referencing-atelier-things.spec.ts
 */

const HELLO_MS = 120_000;
const SKILL_ID = 'e2e-reference-proof';
const MARKER = 'PAPAYA-FORTY-ONE';
/** A card on the fixture's board. */
const CARD = PARENT_CARD;
const CARD_TITLE = 'The card this chat works on';

interface Project {
  id: string;
  path: string;
}

const backend = () => process.env.BEADS_E2E_BACKEND ?? '';

const made: { run: string; id?: string }[] = [];

/** A checkout of its own with a board of its own, registered as a project. */
async function theProject(request: APIRequestContext, name: string): Promise<Project> {
  const run = join(process.cwd(), 'tests', `.workbench-run-references-${name}`);
  const path = makeFixtureProject(join(run, 'project'), join(run, 'reporting'));
  const kept: { run: string; id?: string } = { run };
  made.push(kept);
  const answer = await request.post(`${backend()}/api/projects`, {
    data: { name: `references ${name}`, path, isTest: true },
  });
  expect(answer.status(), await answer.text()).toBe(201);
  const project = (await answer.json()) as Project;
  kept.id = project.id;
  return project;
}

async function aChat(request: APIRequestContext, project: Project): Promise<string> {
  const started = await request.post(`${backend()}/api/workbench/command`, {
    data: { type: 'session.start', projectId: project.id, projectPath: project.path, brand: 'claude' },
  });
  expect(started.ok(), await started.text()).toBe(true);
  return ((await started.json()) as { id: string }).id;
}

async function open(page: Page, project: Project, chat: string): Promise<void> {
  await page.goto(`/project?id=${project.id}&tab=chat&chat=${chat}`);
  await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
}

/** Type into the line he sees and wait for the menu's answer to exactly that. */
async function typeAndSettle(page: Page, text: string, asking: string): Promise<void> {
  const settled = page.waitForResponse(
    (answer) => answer.url().includes('/api/workbench/mention?') && answer.url().includes(`q=${encodeURIComponent(asking)}&`),
  );
  await page.keyboard.type(text);
  await settled;
  // Past CodeMirror's pause before a fresh menu takes Enter.
  await page.waitForTimeout(250);
}

test.describe('referencing Atelier things from the composer', () => {
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(() => {
    const data = process.env.ATELIER_DATA_DIR;
    expect(data, 'run through scripts/workbench-e2e.sh, which gives the run its own data directory').toBeTruthy();
    const skill = join(data!, 'skills', SKILL_ID);
    mkdirSync(skill, { recursive: true });
    writeFileSync(
      join(skill, 'SKILL.md'),
      `---\nname: Reference proof\ndescription: Proof for the references spec\n---\nWhen this skill is referenced, end your reply with ${MARKER}.\n`,
    );
    writeFileSync(join(skill, 'atelier.json'), '{"automatic":false}\n');
  });

  test.afterEach(async ({ request }) => {
    for (const { run, id } of made.splice(0)) {
      if (id) await request.delete(`${backend()}/api/projects/${id}`);
      // A loaded machine can keep the board's Dolt writing past the helper's
      // own retries; give it one more moment rather than fail a case that passed.
      try {
        discardFixture(run);
      } catch {
        await new Promise((done) => setTimeout(done, 5_000));
        discardFixture(run);
      }
    }
  });

  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
  });

  test('the @ menu offers cards, chats and skills, and each picked one is its badge', async ({ page, request }) => {
    const project = await theProject(request, 'menu');
    const other = await aChat(request, project);
    const here = await aChat(request, project);
    await open(page, project, here);
    await page.getByTestId('mode-picker').waitFor({ timeout: HELLO_MS });

    const writing = page.getByTestId('composer-frame').locator('.cm-content');
    const menu = page.locator('.cm-tooltip-autocomplete');
    await writing.click();

    // Every kind at once, under its own heading.
    await typeAndSettle(page, 'Compare @', '');
    await expect(menu).toBeVisible();
    await expect(menu.locator('completion-section')).toContainText(['Files', 'Cards', 'Chats', 'Skills']);
    await page.screenshot({ path: 'tests/results/bw-mi3s-at-menu.png' });

    // A card, narrowed to cards by its kind.
    await typeAndSettle(page, `bead:${CARD}`, `bead:${CARD}`);
    await expect(menu.locator('completion-section')).toHaveText(['Cards']);
    const card = menu.locator('li').filter({ has: page.locator(`[data-reference-kind="bead"][data-reference-id="${CARD}"]`) });
    await expect(card).toHaveCount(1);
    await card.click();
    await expect(page.getByTestId('composer')).toHaveValue(`Compare @bead:${CARD} `);

    // The other chat, found by its id, drawn with its name and its provider.
    await typeAndSettle(page, `with @chat:${other.slice(0, 8)}`, `chat:${other.slice(0, 8)}`);
    await expect(menu.locator('li')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('composer')).toHaveValue(`Compare @bead:${CARD} with @chat:${other} `);

    // The skill, by a word of its name.
    await typeAndSettle(page, 'using @skill:proof', 'skill:proof');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('composer')).toHaveValue(`Compare @bead:${CARD} with @chat:${other} using @skill:${SKILL_ID} `);

    const badges = page.getByTestId('composer-frame').locator('[data-testid="composer-reference"][data-reference-kind]');
    await expect(badges).toHaveCount(3);
    await expect(badges.nth(0)).toHaveAttribute('data-reference-id', CARD);
    await expect(badges.nth(1)).toHaveAttribute('data-brand', 'claude');
    await expect(badges.nth(1).locator('svg[aria-label="Claude"]')).toHaveCount(1);
    await expect(badges.nth(2)).toHaveText('Reference proof');
    await page.getByTestId('composer-frame').screenshot({ path: 'tests/results/bw-mi3s-composer-badges.png' });
  });

  test('a pasted card or chat address becomes its reference', async ({ page, request }) => {
    const project = await theProject(request, 'paste');
    const other = await aChat(request, project);
    const here = await aChat(request, project);
    await open(page, project, here);
    const writing = page.getByTestId('composer-frame').locator('.cm-content');
    await writing.click();
    const paste = (text: string) =>
      writing.evaluate((el, text) => {
        const data = new DataTransfer();
        data.setData('text/plain', text);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }, text);
    const origin = new URL(page.url()).origin;
    await paste(`${origin}/project?id=${project.id}&card=${CARD}`);
    await paste(`${origin}/project?id=${project.id}&tab=chat&chat=${other}`);
    await expect(page.getByTestId('composer')).toHaveValue(`@bead:${CARD} @chat:${other} `);
  });

  test('the agent is told what each reference is, and the message shows the same badges', async ({ page, request }) => {
    test.skip(process.env.BEADS_E2E_LIVE_PROVIDERS !== '1', 'needs a live provider to show what it was told');
    const project = await theProject(request, 'live');
    const other = await aChat(request, project);
    const here = await aChat(request, project);
    await open(page, project, here);
    await page.getByTestId('mode-picker').waitFor({ timeout: HELLO_MS });

    const title = CARD_TITLE;

    await page
      .getByTestId('composer')
      .fill(
        `Reply with one line: the exact title of @bead:${CARD}, then the exact command you were given to read @chat:${other}. Follow @skill:${SKILL_ID}. Use no tools.`,
      );
    await page.getByTestId('send-button').click();
    await expect(page.getByTestId('send-error')).toBeHidden();

    const rows = page.getByTestId('transcript-rows');
    await expect(rows).toContainText(MARKER, { timeout: 180_000 });
    await expect(rows).toContainText(title);
    await expect(rows).toContainText(`atelier tool chat read ${other}`);

    // The sent message: the person's words, with the same badges the composer drew.
    await expect(rows.getByTestId('mention-card').filter({ hasText: CARD }).first()).toBeVisible();
    await expect(rows.getByTestId('mention-chat').first()).toHaveAttribute('data-brand', 'claude');
    await expect(rows.getByTestId('mention-skill').first()).toHaveText('Reference proof');
    await expect(rows).not.toContainText('atelier_references');
    await page.screenshot({ path: 'tests/results/bw-mi3s-sent-badges.png' });

    // And the chat reads back whole, through the command the agent was given.
    const read = await request.get(`${backend()}/api/workbench/chat-text?session=${here}`);
    expect(read.ok()).toBe(true);
    const text = await read.text();
    expect(text).toContain(`Chat ${here}`);
    expect(text).toContain(`User: Reply with one line: the exact title of @bead:${CARD}`);
    expect(text).toContain(MARKER);
    expect(text).not.toContain('atelier_references');
  });
});
