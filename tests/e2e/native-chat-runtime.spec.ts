import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Project = { id: string; path: string };
const FIXTURE = join(__dirname, '..', '.native-chat-runtime');

test('saved and newly opened chats are visible through native Rust routes', async ({ page, request }) => {
  const browserErrors: string[] = [];
  const missing: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() === 404) missing.push(response.url());
  });
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });

  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  execFileSync('git', ['init', '-q', '.'], { cwd: FIXTURE });
  // The app process intentionally has no general-purpose PATH. Keep the empty
  // board readable through the server's documented JSONL fallback even when
  // the disposable bd database has no daemon serving it.
  mkdirSync(join(FIXTURE, '.beads'), { recursive: true });
  writeFileSync(join(FIXTURE, '.beads', 'issues.jsonl'), '');
  mkdirSync(join(FIXTURE, '.atelier'), { recursive: true });
  writeFileSync(
    join(FIXTURE, '.atelier', 'project.toml'),
    'schema_version = 1\n\n[project]\ndisplay_name = "native-chat-runtime"\nuse_beads = true\nsummary = ""\n\n[git]\ncompleted_work_branch = "master"\n\n[beads]\nissue_id_prefix = "nr"\n',
  );

  const made = await request.post('/api/projects', {
    data: { name: 'native-chat-runtime', path: FIXTURE, isTest: true },
  });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as Project;

  const open = async (sessionId: string, title: string, lastActiveAt: string) => {
    const response = await request.post('/api/workbench/command', {
      data: {
        type: 'session.open',
        sessionId,
        externalId: `${sessionId}-provider`,
        brand: 'codex',
        projectId: project.id,
        projectPath: project.path,
        cwd: project.path,
        title,
        lastActiveAt,
      },
    });
    expect(response.status(), await response.text()).toBe(200);
  };

  try {
    const health = await request.get('/api/workbench/health');
    expect(await health.json()).toEqual({ status: 'ok', workbench: 'native' });
    const board = await request.get(`/api/beads?path=${encodeURIComponent(project.path)}`);
    expect(board.status(), await board.text()).toBe(200);

    await open('saved-before-rust', 'Saved before the Rust cutover', '2026-08-29T12:00:00.000Z');
    const sessions = (await (await request.get(`/api/workbench/sessions?project=${project.id}`)).json()) as {
      id: string;
      beads?: string[];
      activity?: string;
    }[];
    expect(sessions).toEqual([
      expect.objectContaining({ id: 'saved-before-rust', beads: [], activity: '' }),
    ]);
    await page.goto(`/project?id=${project.id}&tab=chat`);
    await page.waitForTimeout(2000);
    expect({ browserErrors, missing }, 'the native restore payload crashed the chat screen').toEqual({
      browserErrors: [],
      missing: [],
    });

    const saved = page.locator('[data-testid="restore-row"][data-row-key="saved-before-rust"]');
    await expect(saved).toContainText('Saved before the Rust cutover');

    await open('opened-in-rust', 'Opened by native Rust', '2026-08-30T12:00:00.000Z');
    await page.reload();

    const fresh = page.locator('[data-testid="restore-row"][data-row-key="opened-in-rust"]');
    await expect(saved).toContainText('Saved before the Rust cutover');
    await expect(fresh).toContainText('Opened by native Rust');
    await expect(page.getByTestId('restore-row')).toHaveCount(2);

    await saved.getByTestId('row-name').click();
    await expect(page.getByTestId('chat-tab')).toHaveAttribute('data-session-id', 'saved-before-rust');
    await fresh.getByTestId('row-name').click();
    await expect(page.getByTestId('chat-tab')).toHaveAttribute('data-session-id', 'opened-in-rust');
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
