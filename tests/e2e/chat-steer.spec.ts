import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { quadrantPng } from './fixture-png';

/**
 * Steering the chat you are in: the permission mode, the model, the commands and
 * skills behind `/`, and looking at a picture.
 *
 * Every case opens a fresh chat and sends NO prompt, so a run costs nothing: the
 * menus are what the session announces about itself when it starts
 * (docs/agent-workbench.md §7, §8.2.3).
 *
 * Run: BEADS_E2E_URL=http://127.0.0.1:3017 BEADS_E2E_BACKEND=http://127.0.0.1:3018 \
 *      npx playwright test tests/e2e/chat-steer.spec.ts
 */

/** Starting an agent and hearing back what it can do is a process launch. */
const HELLO_MS = 120_000;

function backend(): string {
  return process.env.BEADS_E2E_BACKEND ?? '';
}

interface Project {
  id: string;
  path: string;
}

/** A chat of its own for this case, with nothing said in it. */
async function freshChat(request: APIRequestContext, page: Page): Promise<{ project: Project; id: string }> {
  const api = backend();
  const projects = (await (await request.get(`${api}/api/projects`)).json()) as Project[];
  expect(projects.length, 'the instance lists no projects').toBeGreaterThan(0);
  const project = process.env.BEADS_E2E_PROJECT
    ? projects.find((p) => p.id === process.env.BEADS_E2E_PROJECT)!
    : projects[0]!;

  const started = (await (
    await request.post(`${api}/api/workbench/command`, {
      data: { type: 'session.start', projectId: project.id, projectPath: project.path, brand: 'claude' },
    })
  ).json()) as { id: string };

  await page.goto(`/project?id=${project.id}&tab=chat&chat=${started.id}`);
  await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
  return { project, id: started.id };
}

test.describe('steering the chat you are in', () => {
  // Starting an agent and waiting for it to say what it can do.
  test.describe.configure({ timeout: 300_000 });

  test('the permission mode is a menu, and picking one changes this chat', async ({ page, request }) => {
    await freshChat(request, page);

    const picker = page.getByTestId('mode-picker');
    await picker.waitFor({ timeout: HELLO_MS });
    const before = await picker.getAttribute('data-current');
    await picker.click();

    const options = page.getByTestId('mode-picker-option');
    await options.first().waitFor({ timeout: 30_000 });
    expect(await options.count(), 'the mode menu is empty').toBeGreaterThan(1);

    // Any mode but the one it is already on, so the change is visible.
    const values = await Promise.all((await options.all()).map((o) => o.getAttribute('data-value')));
    const target = values.find((v) => v && v !== before)!;
    await page.locator(`[data-testid="mode-picker-option"][data-value="${target}"]`).click();

    await expect.poll(async () => picker.getAttribute('data-current'), { timeout: 60_000 }).toBe(target);
    // And the chat's own line agrees, because the change came back as an event.
    await expect(page.getByTestId('session-meta')).toContainText(target, { timeout: 60_000 });
  });

  test('the model is a menu of what this session offers', async ({ page, request }) => {
    await freshChat(request, page);

    const picker = page.getByTestId('model-picker');
    await picker.waitFor({ timeout: HELLO_MS });
    await picker.click();

    const options = page.getByTestId('model-picker-option');
    await options.first().waitFor({ timeout: 30_000 });
    const values = (await Promise.all((await options.all()).map((o) => o.getAttribute('data-value')))).filter(
      (v): v is string => !!v,
    );
    expect(values.length, 'the model menu is empty').toBeGreaterThan(1);

    const before = await picker.getAttribute('data-current');
    const target = values.find((v) => v !== before)!;
    await page.locator(`[data-testid="model-picker-option"][data-value="${target}"]`).click();
    await expect.poll(async () => picker.getAttribute('data-current'), { timeout: 60_000 }).toBe(target);
  });

  test('a slash opens his own commands and skills, and picking one writes it', async ({ page, request }) => {
    await freshChat(request, page);
    // The menu is only as good as what the session announced, so wait for it.
    await page.getByTestId('mode-picker').waitFor({ timeout: HELLO_MS });

    await page.getByTestId('composer').fill('/');
    const menu = page.getByTestId('command-menu');
    await menu.waitFor({ timeout: 60_000 });

    const names = await page.getByTestId('command-option').evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-command') ?? ''),
    );
    expect(names.length, 'the slash menu is empty — the session loaded no commands').toBeGreaterThan(3);
    // A command whose whole point is the terminal cannot work from a browser.
    expect(names, 'a terminal-only command is offered').not.toContain('login');
    expect(names, 'a terminal-only command is offered').not.toContain('exit');

    const wanted = names[0]!;
    await page.locator(`[data-testid="command-option"][data-command="${wanted}"]`).click();
    await expect(page.getByTestId('composer')).toHaveValue(`/${wanted} `);
    await expect(page.getByTestId('command-menu')).toBeHidden();
  });

  test('a picture opens full size when it is clicked', async ({ page, request }) => {
    await freshChat(request, page);

    await page.getByTestId('image-input').setInputFiles({
      name: 'quadrants.png',
      mimeType: 'image/png',
      buffer: quadrantPng(),
    });

    const thumb = page.getByTestId('attachment-thumb').first();
    await thumb.waitFor({ timeout: 30_000 });
    await thumb.click();

    const viewer = page.getByTestId('picture-viewer');
    await viewer.waitFor({ timeout: 30_000 });
    // Full size means bigger than the 48px it was in the tray.
    const box = await page.getByTestId('picture-viewer-image').boundingBox();
    expect(box!.width, 'the picture opened no larger than its thumbnail').toBeGreaterThan(100);

    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden({ timeout: 10_000 });
  });
});
