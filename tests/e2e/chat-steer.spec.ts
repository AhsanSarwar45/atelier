import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** Where every worker in this spec keeps its chats. */
const PROJECT_PATH = process.cwd();

/**
 * A command of this spec's own, planted in the throwaway settings this run uses.
 *
 * The slash menu must prove it read his settings and not just the tool's
 * built-ins. It used to prove that by demanding a namespaced command, which
 * only a plugin supplies — and the harness copies the owner's credentials at
 * most, never his settings, so a run had no plugins and the case could not pass
 * on any machine but his. It now plants its own command and looks for that, so
 * what is proved is the settings directory being read, on any machine
 * (bw-f7tu.3).
 */
const PLANTED_COMMAND = 'atelier-e2e-steer-proof';

/**
 * The project at our path, made if nobody has made it yet.
 *
 * Workers run in parallel and each one arrives here at about the same moment,
 * so looking first is not enough: two can both look, both find nothing, and
 * both post. One wins and the rest are answered `UNIQUE constraint failed:
 * projects.path` as a 500. That is not a failure — the project they wanted now
 * exists — so the loser looks again and adopts it. The five sibling specs are
 * written this way already (bw-f7tu.1).
 */
async function steerProject(request: APIRequestContext): Promise<Project> {
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
    data: { name: 'chat-steer', path: PROJECT_PATH, isTest: true },
  });
  if (made.status() === 201) return (await made.json()) as Project;
  const said = await made.text();
  const raced = await there();
  expect(raced, `no project at ${PROJECT_PATH}, and it could not be made: ${said}`).toBeTruthy();
  return raced!;
}

/** A chat of its own for this case, with nothing said in it. */
async function freshChat(request: APIRequestContext, page: Page, brand: 'claude' | 'codex' = 'claude'): Promise<{ project: Project; id: string }> {
  const api = backend();
  const project = await steerProject(request);

  const started = (await (
    await request.post(`${api}/api/workbench/command`, {
      data: { type: 'session.start', projectId: project.id, projectPath: project.path, brand },
    })
  ).json()) as { id: string };

  await page.goto(`/project?id=${project.id}&tab=chat&chat=${started.id}`);
  await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
  return { project, id: started.id };
}

test.describe('steering the chat you are in', () => {
  // Starting an agent and waiting for it to say what it can do.
  test.describe.configure({ timeout: 300_000 });

  // Written before any chat starts, because a session reads the commands it
  // will offer as it starts.
  test.beforeAll(() => {
    const claude = process.env.CLAUDE_CONFIG_DIR;
    if (!claude) return;
    mkdirSync(join(claude, 'commands'), { recursive: true });
    writeFileSync(
      join(claude, 'commands', `${PLANTED_COMMAND}.md`),
      '---\ndescription: Proof for the chat-steering spec\n---\nSay nothing.\n',
    );
  });

  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
  });

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
    //
    // The badge is asked, not the whole line, and it is asked for the mode it
    // carries rather than for its words: the words are the human label the app
    // draws for that mode ('Edit freely' for acceptEdits), so a line searched
    // for the wire spelling could never match, whatever the chat did
    // (bw-f7tu.2).
    const chip = page.getByTestId('chat-mode-chip');
    await expect.poll(async () => chip.getAttribute('data-mode'), { timeout: 60_000 }).toBe(target);
    // And what it draws is that mode's label. The badge names the same label in
    // its title, so the two are held against each other without this spec
    // keeping its own copy of a table the app owns.
    const title = (await chip.getAttribute('title')) ?? '';
    const label = title.replace(/^Permission mode — /, '');
    expect(label, `the badge names no mode: title was ${title}`).not.toBe('');
    await expect(chip).toHaveText(label);
  });

  test('Codex collaboration mode is separate from permissions and follows this chat', async ({ page, request }) => {
    await freshChat(request, page, 'codex');

    const permissions = page.getByTestId('mode-picker');
    const collaboration = page.getByTestId('collaboration-mode-picker');
    await collaboration.waitFor({ timeout: HELLO_MS });
    await expect(permissions).toHaveAttribute('data-current', /.+/);
    const permissionBefore = await permissions.getAttribute('data-current');

    await collaboration.click();
    const options = page.getByTestId('collaboration-mode-picker-option');
    await options.first().waitFor({ timeout: 30_000 });
    const values = await Promise.all((await options.all()).map((option) => option.getAttribute('data-value')));
    expect(values).toEqual(expect.arrayContaining(['default', 'plan']));

    const before = await collaboration.getAttribute('data-current');
    const target = values.find((value) => value && value !== before)!;
    await page.locator(`[data-testid="collaboration-mode-picker-option"][data-value="${target}"]`).click();

    await expect.poll(async () => collaboration.getAttribute('data-current'), { timeout: 60_000 }).toBe(target);
    await expect(page.getByTestId('session-meta')).toHaveAttribute('data-collaboration-mode', target);
    await expect(permissions).toHaveAttribute('data-current', permissionBefore!);
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
    // His OWN commands, not merely the ones the tool ships with: the one this
    // spec planted in the settings directory the run was given. Its presence is
    // the settings being read; its absence is them being skipped (bw-f1q,
    // bw-f7tu.3).
    expect(
      names,
      'the menu holds only the tool’s own commands — his settings were not loaded',
    ).toContain(PLANTED_COMMAND);

    const wanted = PLANTED_COMMAND;
    await page.locator(`[data-testid="command-option"][data-command="${wanted}"]`).click();
    await expect(page.getByTestId('composer')).toHaveValue(`/${wanted} `);
    await expect(page.getByTestId('command-menu')).toBeHidden();
  });

  test('a sleeping chat does not offer to steer what is not running', async ({ page, request }) => {
    const api = backend();
    // A sleeping chat of its own, made by putting one to sleep.
    //
    // It used to take whichever sleeping chat the instance happened to have and
    // step aside when there was none — which, on the clean instance every run
    // starts from, is always. The case therefore proved nothing on any machine
    // that had not been used by hand first (bw-f7tu.4). Asking the list here
    // also asked without `include_test=true`, because the route that adds it is
    // on the page and not on this request context, so the list came back empty
    // and the case died reading an id off nothing (bw-f7tu.1).
    const { project, id } = await freshChat(request, page);
    await request.post(`${api}/api/workbench/command`, {
      data: { type: 'session.close', sessionId: id },
    });

    // `all=1` because the plain list is a list of OFFERS, and a chat nobody has
    // typed into is not one (registry.ts restoreList). Every chat in this spec
    // is silent on purpose — the menus are what a session announces at startup,
    // so a run costs nothing — which makes the plain list empty of exactly the
    // chat this case just made.
    const q = new URLSearchParams({ project: project.id, path: project.path, all: '1' });
    const stateOf = async (): Promise<string | undefined> => {
      const rows = (await (await request.get(`${api}/api/workbench/restore?${q}`)).json()) as {
        sessionId: string | null;
        state: string;
      }[];
      return rows.find((r) => r.sessionId === id)?.state;
    };
    await expect.poll(stateOf, { timeout: 60_000 }).toBe('dormant');

    await page.goto(`/project?id=${project.id}&tab=chat&chat=${id}`);
    await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
    await page.waitForTimeout(3000);

    // The mode and the model belong to a running agent; on a chat with none they
    // would fail silently, so they are not offered until he writes (bw-f1q.12).
    const mode = page.getByTestId('mode-picker');
    if (await mode.isVisible().catch(() => false)) {
      await expect(mode).toBeDisabled();
    }
    await expect(page.getByTestId('steer-error')).toBeHidden();
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
