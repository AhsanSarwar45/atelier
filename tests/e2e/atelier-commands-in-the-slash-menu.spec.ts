import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Atelier's own commands sit in the `/` menu beside the provider's, and both
 * are there whether or not the chat is awake (bw-zldt.1, bw-zldt.2).
 *
 * An Atelier command is a shared skill made invocable (`automatic: false`). It
 * is named `skill:<id>` and found by its id; sent, the provider is told it is a
 * command the person ran and carries it out, as it would one of its own.
 *
 * Run through scripts/workbench-e2e.sh, which gives the run its own data
 * directory: the command is planted in that library, never the owner's. Its
 * id must not begin with `atelier-`, which is kept for Atelier's built-ins.
 * The case that sends the command needs a signed-in provider:
 *
 *   BEADS_E2E_LIVE_PROVIDERS=1 scripts/workbench-e2e.sh tests/e2e/atelier-commands-in-the-slash-menu.spec.ts
 */

/** Starting an agent and hearing back what it can do is a process launch. */
const HELLO_MS = 120_000;

const COMMAND_ID = 'e2e-slash-proof';
/** What the command tells the provider to answer with, and nothing else. */
const MARKER = 'MANGO-SEVENTY-SEVEN';

function backend(): string {
  return process.env.BEADS_E2E_BACKEND ?? '';
}

interface Project {
  id: string;
  path: string;
}

const PROJECT_PATH = process.cwd();

/** The project at our path, made if nobody has made it yet (see chat-steer.spec.ts). */
async function slashProject(request: APIRequestContext): Promise<Project> {
  const api = backend();
  const there = async (): Promise<Project | undefined> => {
    const listed = (await (await request.get(`${api}/api/projects?include_test=true`)).json()) as Project[];
    return process.env.BEADS_E2E_PROJECT
      ? listed.find((p) => p.id === process.env.BEADS_E2E_PROJECT)
      : listed.find((p) => p.path === PROJECT_PATH);
  };
  const found = await there();
  if (found) return found;
  const made = await request.post(`${api}/api/projects`, {
    data: { name: 'slash-menu', path: PROJECT_PATH, isTest: true },
  });
  if (made.status() === 201) return (await made.json()) as Project;
  const said = await made.text();
  const raced = await there();
  expect(raced, `no project at ${PROJECT_PATH}, and it could not be made: ${said}`).toBeTruthy();
  return raced!;
}

async function freshChat(request: APIRequestContext, page: Page): Promise<{ project: Project; id: string }> {
  const project = await slashProject(request);
  const started = (await (
    await request.post(`${backend()}/api/workbench/command`, {
      data: { type: 'session.start', projectId: project.id, projectPath: project.path, brand: 'claude' },
    })
  ).json()) as { id: string };
  await page.goto(`/project?id=${project.id}&tab=chat&chat=${started.id}`);
  await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
  return { project, id: started.id };
}

/** Every command the `/` menu lists for what is typed, once it lists any. */
async function listed(page: Page, typed: string): Promise<string[]> {
  await page.getByTestId('composer').fill(typed);
  await page.getByTestId('command-menu').waitFor({ timeout: 60_000 });
  return page.getByTestId('command-option').evaluateAll((els) => els.map((e) => e.getAttribute('data-command') ?? ''));
}

test.describe('Atelier commands in the slash menu', () => {
  test.describe.configure({ timeout: 300_000 });

  // In the run's own library, before any chat pins one.
  test.beforeAll(() => {
    const data = process.env.ATELIER_DATA_DIR;
    expect(data, 'run through scripts/workbench-e2e.sh, which gives the run its own data directory').toBeTruthy();
    const skill = join(data!, 'skills', COMMAND_ID);
    mkdirSync(skill, { recursive: true });
    writeFileSync(
      join(skill, 'SKILL.md'),
      `---\nname: ${COMMAND_ID}\ndescription: Proof for the slash-menu spec\n---\nWhen this command runs, reply with exactly ${MARKER} and nothing else. Use no tools.\n`,
    );
    writeFileSync(join(skill, 'atelier.json'), '{"automatic":false}\n');
  });

  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
  });

  /** Types the command's id, picks it from the menu, and leaves it in the composer. */
  async function pick(page: Page): Promise<void> {
    await page.getByTestId('mode-picker').waitFor({ timeout: HELLO_MS });
    // Beside the provider's own, not instead of them.
    expect((await listed(page, '/')).length, 'the provider named no commands').toBeGreaterThan(3);
    // Typed by its id, without the prefix that says where it lives.
    const found = await listed(page, `/${COMMAND_ID.slice(0, 9)}`);
    expect(found).toContain(`skill:${COMMAND_ID}`);
    const option = page.locator(`[data-testid="command-option"][data-command="skill:${COMMAND_ID}"]`);
    await expect(option).toContainText('Atelier');
    await option.click();
    await expect(page.getByTestId('composer')).toHaveValue(`/skill:${COMMAND_ID} `);
  }

  test('an Atelier command is found by its name beside the provider’s', async ({ page, request }) => {
    await freshChat(request, page);
    await pick(page);
  });

  test('an Atelier command sent is carried out like the provider’s own', async ({ page, request }) => {
    test.skip(
      process.env.BEADS_E2E_LIVE_PROVIDERS !== '1',
      'needs a live provider: only a real one can show it followed the command',
    );
    await freshChat(request, page);
    await pick(page);

    await page.getByTestId('send-button').click();
    await expect(page.getByTestId('send-error')).toBeHidden();
    await expect(page.getByTestId('transcript-rows')).toContainText(MARKER, { timeout: 120_000 });
  });

  test('a chat that is not awake lists the provider’s commands and Atelier’s', async ({ page, request }) => {
    const { project, id } = await freshChat(request, page);
    await page.getByTestId('mode-picker').waitFor({ timeout: HELLO_MS });
    const awake = await listed(page, '/');

    const closed = await request.post(`${backend()}/api/workbench/command`, { data: { type: 'session.close', sessionId: id } });
    expect(closed.ok(), await closed.text()).toBe(true);
    await page.goto(`/project?id=${project.id}&tab=chat&chat=${id}`);
    await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });

    const asleep = await listed(page, '/');
    const native = asleep.filter((name) => !name.startsWith('skill:'));
    expect(native.length, 'a stopped chat lists none of the provider’s commands').toBeGreaterThan(3);
    expect(native).toEqual(expect.arrayContaining(awake.filter((name) => !name.startsWith('skill:')).slice(0, 5)));
    expect(asleep, 'a stopped chat lists no Atelier command').toContain(`skill:${COMMAND_ID}`);
  });
});
