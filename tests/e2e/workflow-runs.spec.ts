import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { restartInstance } from './restart';

/**
 * Running a workflow: the owner picks items from the workflow's Items command,
 * each gets a run with a worktree chat, and the Runs list follows it from
 * stage to stage. The scripted ACP agent answers "say you read this" by
 * repeating the prompt. It cannot run `atelier workflow done`, so the stage
 * prompt carries an "Outcome: done" line, the reply fallback, for it to echo.
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
    stages: [{ id: 'implement', name: 'Implement', kind: 'agent', prompt: 'say you read this {{item.identifier}}\nOutcome: done', routes: [],
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
    // A working agent holds the only slot; a run waiting for the owner would not.
    stages: [{ id: 'work', name: 'Work', kind: 'agent', prompt: 'run the long command for {{item.identifier}}', routes: [],
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
  await expect(runs.getByTestId('workflow-run').filter({ hasText: 'KEY-5' }).getByText('Running', { exact: true })).toBeVisible();
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

test('on a phone the chat toolbar keeps its tools under one menu', async ({ page, request }) => {
  await page.setViewportSize({ width: 412, height: 900 });
  await seed(request, [flow(`printf '%s' '${ITEMS}'`)]);
  await page.goto(`/project?id=${project.id}&tab=chat`, { waitUntil: 'networkidle' });
  const more = page.getByRole('button', { name: 'More tools' });
  await expect(more, 'no More tools button on a phone').toBeVisible();
  await expect(page.getByRole('button', { name: 'Run a workflow' })).toBeHidden();
  await expect(page.getByTestId('open-kind-filter')).toBeHidden();
  // One row: the tools sit beside the tabs, not on a row of their own.
  const tabs = await page.getByTestId('project-tabs').boundingBox();
  const tools = await more.boundingBox();
  expect(Math.abs((tools?.y ?? 999) - (tabs?.y ?? 0)), 'the toolbar wrapped onto a second row').toBeLessThan(20);
  await more.click();
  await page.getByRole('menuitem', { name: 'Run a workflow' }).hover();
  await page.getByRole('menuitem', { name: 'Ticket flow' }).click();
  await expect(page.getByRole('dialog', { name: 'Run Ticket flow' })).toBeVisible();
  await page.keyboard.press('Escape');
  await more.click();
  await page.getByRole('menuitem', { name: 'Message kinds' }).click();
  await expect(page.getByTestId('kind-filter-panel')).toBeVisible();
  await page.screenshot({ path: join(results, 'phone-toolbar-menu.png'), animations: 'disabled' });
});

test('on a wide screen the chat toolbar shows its tools as buttons', async ({ page, request }) => {
  await seed(request, [flow(`printf '%s' '${ITEMS}'`)]);
  await page.goto(`/project?id=${project.id}&tab=chat`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('button', { name: 'Run a workflow' })).toBeVisible();
  await expect(page.getByTestId('open-kind-filter')).toBeVisible();
  await expect(page.getByRole('button', { name: 'More tools' })).toBeHidden();
});

test('a run working when the app restarts carries on with its stage', async ({ page, request }) => {
  const items = JSON.stringify([{ identifier: 'KEY-8', title: 'Survive a restart', branchName: 'feature/key-8' }]);
  await seed(request, [{
    ...flow(`printf '%s' '${items}'`),
    // Its own workflow: a run left working by an earlier test holds Ticket flow's slot.
    id: 'restart-flow', name: 'Restart flow',
    stages: [{ id: 'work', name: 'Work', kind: 'agent', prompt: 'run the long command for {{item.identifier}}', routes: [],
      auto: { plan: false, done: false, questions: false } }],
  }]);
  const listed = async () => {
    const answer = await (await request.get(`/api/workbench/workflow-runs?projectPath=${encodeURIComponent(project.path)}`)).json();
    return answer.runs.find((r: { item: { identifier?: string } }) => r.item.identifier === 'KEY-8');
  };
  const started = await request.post('/api/workbench/workflow-runs', {
    data: { action: 'start', projectId: project.id, projectPath: project.path, workflow: 'restart-flow', items: [JSON.parse(items)[0]] },
  });
  expect(started.ok(), await started.text()).toBeTruthy();
  await expect.poll(async () => (await listed())?.status).toBe('running');

  // The computer shuts down mid-stage: the app and its agent are gone.
  await restartInstance({
    binary: process.env.ATELIER_BINARY ?? join(__dirname, '..', '..', 'server', 'target', 'debug', 'atelier'),
    serverPort: Number(process.env.BEADS_WEB_PORT),
    sidecarPort: Number(process.env.BEADS_WORKBENCH_PORT),
    env: process.env,
    healthUrl: `${process.env.BEADS_E2E_URL}/api/workbench/health`,
    logFile: join(run, 'server.log'),
  });
  // The minute tick, now rather than in a minute.
  const ticked = await request.post('/api/workbench/workflow-runs', { data: { action: 'tick', projectId: project.id, projectPath: project.path } });
  expect(ticked.ok(), await ticked.text()).toBeTruthy();
  await expect.poll(async () => (await listed())?.attempts?.work, { message: 'the stage was not sent again after the restart' }).toBe(2);
  const resumed = await listed();
  expect(resumed.status, 'the run did not carry on').toBe('running');

  await page.goto(`/project?id=${project.id}&tab=chat&chat=${resumed.sessionId}`);
  await expect(page.getByText('run the long command for KEY-8', { exact: false }), 'the chat was not sent its stage again').toHaveCount(2, { timeout: 30_000 });
  await page.screenshot({ path: join(results, 'resumed-after-restart.png'), animations: 'disabled' });
});

// A workflow chat says which stage its run is on, in the chat's badge bar and
// on its sidebar row. The first stage is an Approval, so the run waits there.
const LONG = 'Wait for the owner to review the pull request and merge it into staging before the release goes out';
function stageFlow(first: string) {
  return {
    ...flow(`printf '[]'`), id: 'stage-flow', name: 'Stage flow',
    stages: [
      { id: 'plan-check', name: first, kind: 'approval', prompt: '', routes: [{ outcome: 'done', to: 'implement' }] },
      { id: 'implement', name: 'Implement', kind: 'agent', prompt: 'say you read this {{item.identifier}}\nOutcome: done',
        routes: [{ outcome: 'done', to: 'review' }], auto: { plan: false, done: false, questions: false } },
      { id: 'review', name: 'Review', kind: 'approval', prompt: '', routes: [] },
    ],
  };
}
async function stageRun(request: APIRequestContext, first: string, identifier: string) {
  await seed(request, [stageFlow(first)]);
  const started = await request.post('/api/workbench/workflow-runs', {
    data: { action: 'start', projectId: project.id, projectPath: project.path, workflow: 'stage-flow',
      items: [{ identifier, title: 'Show the stage', branchName: `feature/${identifier.toLowerCase()}` }] },
  });
  expect(started.ok(), await started.text()).toBeTruthy();
  const id = (await started.json()).runs[0].id;
  const read = async () => {
    const answer = await (await request.get(`/api/workbench/workflow-runs?projectPath=${encodeURIComponent(project.path)}`)).json();
    return answer.runs.find((r: { id: string }) => r.id === id);
  };
  await expect.poll(async () => (await read())?.status, { timeout: 30_000 }).toBe('needs_owner');
  return { id, read, session: (await read()).sessionId as string };
}
const act = (request: APIRequestContext, action: string, run: string) =>
  request.post('/api/workbench/workflow-runs', { data: { action, run, projectId: project.id, projectPath: project.path } });

test('a workflow chat shows its stage in the badge bar and on its sidebar row', async ({ page, request }) => {
  const run = await stageRun(request, 'Check the plan', 'KEY-21');
  await page.goto(`/project?id=${project.id}&tab=chat&chat=${run.session}`);
  const header = page.getByTestId('chat-status-line').getByTestId('chat-workflow-stage');
  const row = page.getByTestId('restore-row').filter({ hasText: 'KEY-21' });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: join(results, 'workflow-chat.png'), animations: 'disabled' });

  await expect(header, 'the badge bar does not name the stage').toHaveText('Check the plan', { timeout: 15_000 });
  await expect(row.getByTestId('row-workflow-stage'), 'the sidebar row does not name the stage').toHaveText('Check the plan');
  await header.hover();
  await expect(page.getByRole('tooltip'), 'the badge does not say which workflow and how far along').toHaveText('Stage flow workflow, stage 1 of 3');
  await page.mouse.move(0, 0);

  // The owner continues: the agent stage runs and the run waits on Review.
  // The badges follow without a reload.
  expect((await act(request, 'continue', run.id)).ok()).toBeTruthy();
  await expect(header, 'the badge bar kept the stage the run left').toHaveText('Review', { timeout: 30_000 });
  await expect(row.getByTestId('row-workflow-stage'), 'the sidebar row kept the stage the run left').toHaveText('Review');
  await page.screenshot({ path: join(results, 'workflow-chat.png'), animations: 'disabled' });

  // A run that ends leaves an ordinary chat.
  expect((await act(request, 'stop', run.id)).ok()).toBeTruthy();
  await expect(header, 'a stopped run still shows its stage').toHaveCount(0, { timeout: 15_000 });
  await expect(row.getByTestId('row-workflow-stage'), 'a stopped run still shows its stage on the row').toHaveCount(0);
});

test('a long stage name is cut short without moving the badge bar or the row', async ({ page, request }) => {
  const run = await stageRun(request, LONG, 'KEY-22');
  await page.goto(`/project?id=${project.id}&tab=chat&chat=${run.session}`);
  const line = page.getByTestId('chat-status-line');
  const row = page.getByTestId('restore-row').filter({ hasText: 'KEY-22' });
  const chip = line.getByTestId('chat-workflow-stage');
  const rowChip = row.getByTestId('row-workflow-stage');
  await expect(chip, 'the badge bar does not name the stage').toHaveText(LONG, { timeout: 15_000 });
  await expect(rowChip, 'the sidebar row does not name the stage').toHaveText(LONG);
  const cut = (el: HTMLElement) => {
    const text = el.querySelector('span') ?? el;
    return text.scrollWidth > text.clientWidth;
  };
  expect(await chip.evaluate(cut), 'the long name was not cut short in the badge bar').toBe(true);
  expect(await rowChip.evaluate(cut), 'the long name was not cut short on the row').toBe(true);
  expect((await chip.boundingBox())!.width, 'the badge grew past its width').toBeLessThanOrEqual(260);
  // The bar is 40px tall with its padding; a second line of chips would put
  // the stage below the branch.
  const branch = (await line.getByTestId('chat-branch-chip').boundingBox())!;
  const stageBox = (await chip.boundingBox())!;
  expect(Math.abs((stageBox.y + stageBox.height / 2) - (branch.y + branch.height / 2)), 'the badge bar wrapped onto a second line').toBeLessThanOrEqual(2);
  expect((await line.boundingBox())!.height, 'the badge bar wrapped onto a second line').toBeLessThanOrEqual(44);
  const rowBox = (await row.boundingBox())!;
  const chipBox = (await rowChip.boundingBox())!;
  expect(chipBox.x + chipBox.width, 'the stage runs past the row').toBeLessThanOrEqual(rowBox.x + rowBox.width);
  const pill = (await row.getByTestId('row-pill').boundingBox())!;
  expect(chipBox.x, 'the stage covers the chat state on the row').toBeGreaterThanOrEqual(pill.x + pill.width);
  expect(await row.getByTestId('row-pill').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'the chat state was squeezed past its word').toBe(true);
  await expect(row.locator('[data-testid^="row-line"]'), 'the row drew more than two lines').toHaveCount(2);
  await page.screenshot({ path: join(results, 'long-stage.png'), animations: 'disabled' });
  await act(request, 'stop', run.id);
});

test('the stage badge fits a phone', async ({ page, request }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  const run = await stageRun(request, LONG, 'KEY-23');
  await page.goto(`/project?id=${project.id}&tab=chat&chat=${run.session}`);
  const chip = page.getByTestId('chat-status-line').getByTestId('chat-workflow-stage');
  await expect(chip, 'the stage is not shown on a phone').toBeVisible({ timeout: 15_000 });
  const box = (await chip.boundingBox())!;
  expect(box.x + box.width, 'the stage runs past the screen edge').toBeLessThanOrEqual(375);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, 'nothing runs past the screen edge').toBeLessThanOrEqual(0);
  await page.screenshot({ path: join(results, 'phone-stage.png'), animations: 'disabled' });
  await act(request, 'stop', run.id);
});
