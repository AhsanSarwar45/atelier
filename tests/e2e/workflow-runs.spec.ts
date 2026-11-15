import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Running a workflow: the owner picks items from the workflow's Items command,
 * each gets a run with a worktree chat, and the Runs list follows it from
 * stage to stage. The scripted ACP agent answers "say you read this" by
 * repeating the prompt, which carries the "Outcome: done" line back.
 *
 * Run: tests/e2e/workflow-runs.sh 'test name'
 */

test.describe.configure({ mode: 'serial' });
test.skip(!process.env.BEADS_E2E_ACP_ADAPTERS?.includes('tests/fixtures/acp-adapters'), 'needs the scripted ACP agent');
const run = process.env.WORKBENCH_E2E_RUN!;
const results = 'tests/results/workflow-runs';
const api = '/api/settings/workflows';
let project: { id: string; path: string };

const ITEMS = JSON.stringify([
  { identifier: 'KEY-1', title: 'Fix login', branchName: 'feature/key-1-fix-login' },
  { identifier: 'KEY-2', title: 'Rename courses', branchName: 'feature/key-2-rename-courses' },
]);
function flow(items: string) {
  return {
    id: 'ticket-flow', name: 'Ticket flow', enabled: true,
    trigger: { kind: 'manual', items },
    agent: { brand: 'claude' },
    setup: { branch: '{{item.branchName}}', base: 'main' },
    stages: [{ id: 'implement', name: 'Implement', kind: 'agent', prompt: 'say you read this {{item.identifier}}', routes: [],
      auto: { plan: false, done: false, questions: false } }],
  };
}
async function seed(request: APIRequestContext, workflows: unknown[]) {
  const url = `${api}?path=${encodeURIComponent(project.path)}`;
  const held = await (await request.get(url)).json();
  const saved = await request.put(url, { data: { workflows, revision: held.revision } });
  expect(saved.ok(), await saved.text()).toBeTruthy();
}
async function openFlow(page: Page) {
  await page.goto(`/project?id=${project.id}&settings=workflows`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Ticket flow/ }).first().click();
  await expect(page).toHaveURL(/pitem=/);
}

test.beforeAll(async ({ request }) => {
  expect(run, 'run through the isolated harness').toBeTruthy();
  mkdirSync(join(run, 'projects'), { recursive: true });
  mkdirSync(results, { recursive: true });
  const path = mkdtempSync(join(run, 'projects', 'runs-'));
  execFileSync('git', ['init', '-q', '-b', 'main', path]);
  writeFileSync(join(path, 'README.md'), '# Run demo\n');
  execFileSync('git', ['-C', path, 'add', 'README.md']);
  execFileSync('git', ['-C', path, '-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'first']);
  const made = await request.post('/api/projects', { data: { name: 'Run demo', path } });
  expect(made.status(), await made.text()).toBe(201);
  project = await made.json();
  expect((await request.get(`/api/projects/${project.id}/settings`)).ok()).toBeTruthy();
});
test.afterAll(async ({ request }) => {
  if (project) await request.delete(`/api/projects/${project.id}`);
});

test('runs a workflow on a picked item and follows it to its chat', async ({ page, request }) => {
  await seed(request, [flow(`printf '%s' '${ITEMS}'`)]);
  await openFlow(page);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Run Ticket flow' });
  await expect(dialog.getByRole('checkbox', { name: /KEY-1.*Fix login/ })).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: /KEY-2.*Rename courses/ })).toBeVisible();
  await dialog.getByRole('checkbox', { name: /KEY-1/ }).check();
  await dialog.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(dialog).toBeHidden();

  const runs = page.getByTestId('workflow-runs');
  const row = runs.getByTestId('workflow-run').filter({ hasText: 'KEY-1' });
  await expect(row).toBeVisible();
  await expect(runs.getByTestId('workflow-run').filter({ hasText: 'KEY-2' })).toHaveCount(0);
  // The scripted agent repeats the prompt, "Outcome: done" included, and the
  // only stage has no route, so the run finishes.
  await expect(row.getByText('Done', { exact: true })).toBeVisible({ timeout: 30_000 });
  await runs.screenshot({ path: join(results, 'runs.png'), animations: 'disabled' });

  const listed = await (await request.get(`/api/workbench/workflow-runs?projectPath=${encodeURIComponent(project.path)}`)).json();
  const started = listed.runs.find((r: any) => r.item.identifier === 'KEY-1');
  expect(execFileSync('git', ['-C', started.cwd, 'rev-parse', '--abbrev-ref', 'HEAD']).toString().trim()).toBe('feature/key-1-fix-login');

  await row.getByRole('link', { name: 'Open chat' }).click();
  await expect(page.getByText(/read: say you read this KEY-1/).first()).toBeVisible({ timeout: 15_000 });
});

test('the run dialog says why the items command failed', async ({ page, request }) => {
  await seed(request, [flow(`echo 'linear: not logged in' >&2; exit 1`)]);
  await openFlow(page);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Run Ticket flow' });
  await expect(dialog.getByText(/not logged in/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
  await dialog.screenshot({ path: join(results, 'items-error.png'), animations: 'disabled' });
});

test('the runs list and run dialog fit a phone', async ({ page, request }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await seed(request, [flow(`printf '%s' '${ITEMS}'`)]);
  await openFlow(page);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Run Ticket flow' }).getByRole('checkbox', { name: /KEY-2/ })).toBeVisible();
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, 'nothing runs past the screen edge').toBeLessThanOrEqual(0);
  await page.screenshot({ path: join(results, 'phone-run-dialog.png'), animations: 'disabled' });
});

test('the editor sets the agent and how many runs work at once', async ({ page, request }) => {
  await seed(request, [flow(`printf '%s' '${ITEMS}'`)]);
  await openFlow(page);
  await expect(page.getByRole('combobox', { name: 'Agent' })).toHaveText(/Claude/);
  await expect(page.getByRole('combobox', { name: 'Model' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Effort' })).toBeVisible();
  await page.getByRole('spinbutton', { name: 'Runs at once' }).fill('2');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  const saved = await (await request.get(`${api}?path=${encodeURIComponent(project.path)}`)).json();
  expect(saved.workflows[0].agent.brand).toBe('claude');
  expect(saved.workflows[0].max_concurrent).toBe(2);
  await page.getByTestId('workflows-settings').screenshot({ path: join(results, 'agent-and-limit.png'), animations: 'disabled' });
});

test('the run dialog starts with the workflow agent and can change it', async ({ page, request }) => {
  await seed(request, [flow(`printf '%s' '${ITEMS}'`)]);
  await openFlow(page);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Run Ticket flow' });
  await expect(dialog.getByRole('combobox', { name: 'Agent' })).toHaveText(/Claude/);
  await expect(dialog.getByRole('combobox', { name: 'Model' })).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Effort' })).toBeVisible();
  await dialog.screenshot({ path: join(results, 'run-dialog-agent.png'), animations: 'disabled' });
});

test('runs past the limit show as queued', async ({ page, request }) => {
  const items = JSON.stringify([
    { identifier: 'KEY-5', title: 'Queue one', branchName: 'feature/key-5' },
    { identifier: 'KEY-6', title: 'Queue two', branchName: 'feature/key-6' },
  ]);
  const queued = {
    ...flow(`printf '%s' '${items}'`),
    max_concurrent: 1,
    stages: [{ id: 'check', name: 'Check', kind: 'approval', prompt: 'Look at {{item.identifier}}', routes: [],
      auto: { plan: false, done: false, questions: false } }],
  };
  await seed(request, [queued]);
  await openFlow(page);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Run Ticket flow' });
  await dialog.getByRole('checkbox', { name: /KEY-5/ }).check();
  await dialog.getByRole('checkbox', { name: /KEY-6/ }).check();
  await dialog.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(dialog).toBeHidden();
  const runs = page.getByTestId('workflow-runs');
  await expect(runs.getByTestId('workflow-run').filter({ hasText: 'KEY-5' }).getByText('Needs you', { exact: true })).toBeVisible();
  await expect(runs.getByTestId('workflow-run').filter({ hasText: 'KEY-6' }).getByText('Queued', { exact: true })).toBeVisible();
  await runs.screenshot({ path: join(results, 'runs-queued.png'), animations: 'disabled' });
});

test('the chat toolbar picks a workflow and starts it', async ({ page, request }) => {
  await seed(request, [{ ...flow(`echo '${JSON.stringify([{ identifier: 'KEY-7', title: 'From the toolbar', branchName: 'feature/key-7' }])}'`) }]);
  await page.goto(`/project?id=${project.id}&tab=chat`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Run a workflow' }).click();
  await page.getByRole('menuitem', { name: 'Ticket flow' }).click();
  const dialog = page.getByRole('dialog', { name: 'Run Ticket flow' });
  await dialog.getByRole('checkbox').first().check();
  await expect(dialog.getByRole('combobox', { name: 'Agent' })).toContainText(/Claude/);
  await dialog.getByRole('button', { name: 'Start' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => {
    const answer = await (await request.get(`/api/workbench/workflow-runs?projectPath=${encodeURIComponent(project.path)}`)).json();
    return answer.runs.some((r: { item: { identifier?: string } }) => r.item.identifier === 'KEY-7');
  }).toBe(true);
  await page.getByRole('button', { name: 'Run a workflow' }).click();
  await page.screenshot({ path: join(results, 'toolbar-workflows.png'), animations: 'disabled' });
});
