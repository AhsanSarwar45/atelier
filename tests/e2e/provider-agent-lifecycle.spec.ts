import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

type Brand = 'claude' | 'codex';
type Project = { id: string; path: string };
type LifecycleEvent = { type: string; agentId: string; state?: string };

const ROOT = join(__dirname, '..', '.workbench-run-provider-lifecycle');
const SHOTS = 'tests/results';
const TURN_MS = 600_000;
const SETTLE_MS = 30_000;

const cases: { brand: Brand; permissionMode: string; prompt: string; parentAnswer: string; childAnswer: string }[] = [
  {
    brand: 'claude', permissionMode: 'bypassPermissions', parentAnswer: 'CLAUDE PARENT DONE', childAnswer: 'CLAUDE CHILD DONE',
    prompt: 'Use the Task tool exactly once with run_in_background=true to launch one general-purpose subagent. ' +
      'Tell it to use no tools and reply exactly CLAUDE CHILD DONE. Wait until that background task finishes. ' +
      'Do not launch any other subagent or workflow, and do not narrate the launch or wait in assistant prose. ' +
      'Then reply exactly CLAUDE PARENT DONE.',
  },
  {
    brand: 'codex', permissionMode: 'never', parentAnswer: 'CODEX PARENT DONE', childAnswer: 'CODEX CHILD DONE',
    prompt: 'Call spawn_agent exactly once. Tell that agent to use no tools and reply exactly CODEX CHILD DONE. ' +
      'Wait for that agent to finish with wait_agent. Do not spawn any other agent, and do not narrate the launch or wait ' +
      'in assistant prose. Then reply exactly CODEX PARENT DONE.',
  },
];

async function createProject(request: APIRequestContext, brand: Brand): Promise<Project> {
  const path = join(ROOT, brand);
  mkdirSync(path, { recursive: true });
  const response = await request.post('/api/projects', { data: { name: `provider-lifecycle-${brand}`, path, isTest: true } });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as Project;
}

async function startSession(request: APIRequestContext, project: Project, brand: Brand, permissionMode: string): Promise<string> {
  const response = await request.post('/api/workbench/command', {
    data: { type: 'session.start', projectId: project.id, projectPath: project.path, brand, permissionMode },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { id: string }).id;
}

function lifecycleEvents(sessionId: string): LifecycleEvent[] {
  const database = join(process.env.ATELIER_DATA_DIR!, 'workbench.db');
  const escaped = sessionId.replaceAll("'", "''");
  const sql = `SELECT json FROM event WHERE session_id = '${escaped}' AND type IN ('agent.started','agent.finished') ORDER BY seq`;
  const output = execFileSync('sqlite3', ['-json', database, sql], { encoding: 'utf8' }).trim();
  if (!output) return [];
  return (JSON.parse(output) as { json: string }[]).map((row) => JSON.parse(row.json) as LifecycleEvent);
}

function lifecycleShape(sessionId: string): { count: number; types: string[]; oneAgent: boolean; state: string | undefined } {
  const events = lifecycleEvents(sessionId);
  return {
    count: events.length,
    types: events.map((event) => event.type),
    oneAgent: events.length === 2 && events[0]?.agentId === events[1]?.agentId,
    state: events[1]?.state,
  };
}

test.describe('native provider child-agent lifecycle', () => {
  test.describe.configure({ mode: 'serial', timeout: TURN_MS });

  test.beforeAll(() => {
    expect(process.env.BEADS_E2E_LIVE_PROVIDERS, 'set BEADS_E2E_LIVE_PROVIDERS=1').toBe('1');
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
    mkdirSync(SHOTS, { recursive: true });
  });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
  });

  for (const provider of cases) {
    test(`${provider.brand} reports one native child start and one terminal finish`, async ({ page, request }) => {
      let project: Project | undefined;
      try {
        project = await createProject(request, provider.brand);
        const sessionId = await startSession(request, project, provider.brand, provider.permissionMode);
        await page.goto(`/project?id=${project.id}&tab=chat&chat=${sessionId}`);
        await page.getByTestId('chat-tab').waitFor({ timeout: 120_000 });
        const promptStarted = performance.now();
        const sent = await request.post('/api/workbench/command', {
          data: { type: 'prompt.send', sessionId, text: provider.prompt },
        });
        const promptAckMs = performance.now() - promptStarted;
        expect(sent.ok(), await sent.text()).toBe(true);
        expect(promptAckMs, `${provider.brand} prompt acknowledgement took ${promptAckMs.toFixed(1)}ms`).toBeLessThan(500);

        await expect(page.getByTestId('assistant-message').last()).toContainText(provider.parentAnswer, { timeout: SETTLE_MS });
        const rows = page.getByTestId('sent-away-row');
        await expect(rows).toHaveCount(1);
        await expect(rows.first()).toHaveAttribute('data-kind', 'helper');
        await expect(rows.first()).toHaveAttribute('data-state', 'done', { timeout: SETTLE_MS });

        const parentMessages = await page.getByTestId('assistant-message').allInnerTexts();
        expect(parentMessages.some((text) => text.includes(provider.childAnswer)),
          `${provider.brand} drew its child's answer as an ordinary parent message`).toBe(false);
        expect(parentMessages.some((text) => text.includes(provider.parentAnswer))).toBe(true);

        const agentTools = page.locator('[data-testid="tool-row"][data-ran-kind="agent"]');
        await expect(agentTools.first().getByTestId('tool-mark')).toBeVisible();
        if (provider.brand === 'codex') {
          const spawned = page.locator('[data-testid="tool-row"][data-tool-name="spawn_agent"]');
          const waited = page.locator('[data-testid="tool-row"][data-tool-name="wait_agent"]');
          await expect(spawned).toHaveCount(1);
          await expect(spawned).toContainText('Child finished');
          await expect(waited).toHaveCount(1);
          await expect(waited).toContainText(/Waited for (child|helper|CODEX|Inspect)/i);
          await expect(waited.getByTestId('tool-mark')).toBeVisible();
        }

        await expect.poll(() => lifecycleShape(sessionId), {
          timeout: 30_000, message: `${provider.brand} did not persist exactly one start and finish`,
        }).toEqual({ count: 2, types: ['agent.started', 'agent.finished'], oneAgent: true, state: 'done' });

        // Late bookkeeping must not reopen or duplicate the child.
        await page.waitForTimeout(2_000);
        await expect(rows).toHaveCount(1);
        await expect(rows.first()).toHaveAttribute('data-state', 'done');
        expect(lifecycleEvents(sessionId)).toHaveLength(2);

        // Reload proves the terminal row is persisted, not retained in React.
        await page.reload();
        await page.getByTestId('chat-tab').waitFor({ timeout: 120_000 });
        await expect(page.getByTestId('sent-away-row')).toHaveCount(1);
        await expect(page.getByTestId('sent-away-row')).toHaveAttribute('data-state', 'done');
        await expect(page.getByTestId('sent-away-row')).toContainText('Done');
        if (provider.brand === 'claude') {
          await expect(page.locator('[data-testid="tool-row"][data-tool-name="Agent"]'))
            .toContainText('general-purpose finished');
        } else {
          await expect(page.locator('[data-testid="tool-row"][data-tool-name="spawn_agent"]'))
            .toContainText('Child finished');
          await expect(page.locator('[data-testid="tool-row"][data-tool-name="wait_agent"]'))
            .toContainText('Waited for Child');
        }
        await page.screenshot({ path: `${SHOTS}/provider-agent-lifecycle-${provider.brand}.png`, fullPage: false });
      } finally {
        if (project) await request.delete(`/api/projects/${project.id}`);
      }
    });
  }
});
