import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Project settings > Workflows: a list of the project's workflows and an
 * editor for one, whose stage prompts are written in the chat's own box.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/workflows-settings.spec.ts
 */

test.describe.configure({ mode: 'serial' });
const run = process.env.WORKBENCH_E2E_RUN!;
const results = 'tests/results/workflows-settings';
const api = '/api/settings/workflows';
const SKILL_ID = 'ticket-qa';
let project: { id: string; path: string };

async function stored(request: APIRequestContext) {
  const answer = await request.get(`${api}?path=${encodeURIComponent(project.path)}`);
  expect(answer.ok(), await answer.text()).toBeTruthy();
  return (await answer.json()) as { workflows: Array<Record<string, any>>; revision: string };
}
async function seed(request: APIRequestContext, workflows: unknown[]) {
  const held = await stored(request);
  const saved = await request.put(`${api}?path=${encodeURIComponent(project.path)}`, { data: { workflows, revision: held.revision } });
  expect(saved.ok(), await saved.text()).toBeTruthy();
}
const DEMO = {
  id: 'demo-flow', name: 'Demo flow', enabled: true, trigger: { kind: 'manual' }, setup: {},
  stages: [
    { id: 'implement', name: 'Implement', kind: 'agent', prompt: 'Work on {{item.identifier}}', routes: [] },
    { id: 'qa', name: 'QA', kind: 'agent', prompt: '', routes: [] },
  ],
};
async function demo(request: APIRequestContext) {
  const held = await stored(request);
  if (!held.workflows.some((w) => w.id === DEMO.id)) await seed(request, [...held.workflows, DEMO]);
}
async function openWorkflows(page: Page) {
  await page.goto(`/project?id=${project.id}&settings=workflows`, { waitUntil: 'networkidle' });
  await expect(page.getByTestId('workflows-settings')).toBeVisible();
}
async function newWorkflow(page: Page, name: string) {
  await page.getByRole('button', { name: 'New workflow', exact: true }).click();
  await expect(page).toHaveURL(/pitem=/);
  await page.getByLabel('Name', { exact: true }).first().fill(name);
}
async function addStage(page: Page, name: string, kind: 'Agent' | 'Command' | 'Wait' | 'Approval') {
  await page.getByRole('button', { name: 'Add stage', exact: true }).click();
  const stage = page.getByTestId('workflow-stage').last();
  await stage.getByLabel('Stage name', { exact: true }).fill(name);
  await stage.getByRole('radio', { name: kind, exact: true }).click();
  return stage;
}
async function save(page: Page) {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
}
async function noSideScroll(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, 'nothing runs past the screen edge').toBeLessThanOrEqual(0);
}

test.beforeAll(async ({ request }) => {
  expect(run, 'run through the isolated harness').toBeTruthy();
  mkdirSync(join(run, 'projects'), { recursive: true });
  mkdirSync(results, { recursive: true });
  const path = mkdtempSync(join(run, 'projects', 'workflows-'));
  execFileSync('git', ['init', '-q', '-b', 'main', path]);
  writeFileSync(join(path, 'README.md'), '# Workflow demo\n');
  const made = await request.post('/api/projects', { data: { name: 'Workflow demo', path } });
  expect(made.status(), await made.text()).toBe(201);
  project = await made.json();
  // Opening the project's settings gives it the manifest workflows live beside.
  expect((await request.get(`/api/projects/${project.id}/settings`)).ok()).toBeTruthy();
  // A project skill, added the way the Agent guidance page adds one.
  const library = `/api/settings/library?path=${encodeURIComponent(path)}`;
  const held = await (await request.get(library)).json();
  const skill = { id: SKILL_ID, name: 'Ticket QA', kind: 'skill', description: 'Test a ticket in the browser.', content: 'Test it.' };
  const added = await request.put(library, { data: { library: { items: [skill], overrides: {} }, revision: held.revision } });
  expect(added.ok(), await added.text()).toBeTruthy();
});
test.afterAll(async ({ request }) => {
  if (project) await request.delete(`/api/projects/${project.id}`);
});

test('creates a workflow from the empty list', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWorkflows(page);
  await expect(page.getByText('No workflows yet', { exact: true })).toBeVisible();
  await page.screenshot({ path: join(results, 'empty.png') });
  await newWorkflow(page, 'Keystone ticket');
  await save(page);
  await page.getByTestId('back-to-list').click();
  await expect(page.getByTestId('workflow-row-keystone-ticket')).toContainText('Keystone ticket');
  expect((await stored(request)).workflows.map((w) => w.name)).toEqual(['Keystone ticket']);
});

test('builds stages with routes and a schedule that persist', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWorkflows(page);
  await newWorkflow(page, 'Routes demo');
  await page.getByRole('combobox', { name: 'Trigger', exact: true }).click();
  await page.getByRole('option', { name: 'Schedule', exact: true }).click();
  await page.getByLabel('Every', { exact: true }).fill('10');
  await page.getByLabel('Items command', { exact: true }).fill('linear issue list --label agent-ready --json');
  await addStage(page, 'Implement', 'Agent');
  await addStage(page, 'QA', 'Agent');
  const first = page.getByTestId('workflow-stage').first();
  await first.getByRole('button', { name: 'Add route', exact: true }).click();
  await first.getByLabel('Outcome', { exact: true }).fill('done');
  await first.getByRole('combobox', { name: 'Go to', exact: true }).click();
  await page.getByRole('option', { name: 'QA', exact: true }).click();
  await save(page);
  await page.screenshot({ path: join(results, 'editor.png'), fullPage: true });

  await page.reload();
  await expect(page.getByTestId('workflow-stage')).toHaveCount(2);
  const flow = (await stored(request)).workflows.find((w) => w.name === 'Routes demo')!;
  expect(flow.trigger).toMatchObject({ kind: 'schedule', every_minutes: 10 });
  expect(flow.stages.map((s: any) => [s.name, s.kind])).toEqual([['Implement', 'agent'], ['QA', 'agent']]);
  expect(flow.stages[0].routes).toEqual([{ outcome: 'done', to: flow.stages[1].id }]);
});

test('stage prompts autocomplete skills and files like the chat box', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await demo(request);
  await openWorkflows(page);
  await page.getByTestId('workflow-row-demo-flow').click();
  const writing = page.getByTestId('workflow-stage').nth(1).getByTestId('stage-prompt').locator('.cm-content');
  const menu = page.locator('.cm-tooltip-autocomplete');
  await writing.click();
  await page.keyboard.type('/ticket');
  // The / menu draws a skill as the chat's does: its command and description.
  await expect(menu).toContainText(`/skill:${SKILL_ID}`);
  await expect(menu).toContainText('Test a ticket in the browser.');
  await page.screenshot({ path: join(results, 'slash-menu.png') });
  // Past CodeMirror's pause before a fresh menu takes Enter.
  await page.waitForTimeout(250);
  await page.keyboard.press('Enter');
  await page.keyboard.type(' check @READ');
  await expect(menu).toContainText('README.md');
  await page.waitForTimeout(250);
  await page.keyboard.press('Enter');
  await save(page);
  const prompt: string = (await stored(request)).workflows.find((w) => w.id === 'demo-flow')!.stages[1].prompt;
  expect(prompt).toContain(`/skill:${SKILL_ID}`);
  expect(prompt).toContain('README.md');
});

test('reorders stages with the keyboard', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await demo(request);
  await openWorkflows(page);
  await page.getByTestId('workflow-row-demo-flow').click();
  await page.getByRole('button', { name: 'Reorder QA', exact: true }).focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await expect(page.getByTestId('workflow-stage').first().getByLabel('Stage name', { exact: true })).toHaveValue('QA');
  await save(page);
  expect((await stored(request)).workflows.find((w) => w.id === 'demo-flow')!.stages.map((s: any) => s.name)).toEqual(['QA', 'Implement']);
});

test('agent stages switch automatic approval on and off per stage', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await demo(request);
  await openWorkflows(page);
  await page.getByTestId('workflow-row-demo-flow').click();
  const implement = page.getByTestId('workflow-stage').filter({ has: page.getByRole('button', { name: 'Reorder Implement', exact: true }) });
  const plan = implement.getByRole('switch', { name: 'Approve plan', exact: true });
  const done = implement.getByRole('switch', { name: 'Approve finished work', exact: true });
  const questions = implement.getByRole('switch', { name: 'Answer questions', exact: true });
  // Off until the owner turns each one on.
  for (const control of [plan, done, questions]) await expect(control).not.toBeChecked();
  await plan.click();
  await questions.click();
  await save(page);
  const stage = (await stored(request)).workflows.find((w) => w.id === 'demo-flow')!.stages.find((s: any) => s.id === 'implement');
  expect(stage.auto).toEqual({ plan: true, done: false, questions: true });
  await page.reload();
  await expect(plan).toBeChecked();
  await expect(done).not.toBeChecked();
  await expect(questions).toBeChecked();
  await implement.screenshot({ path: join(results, 'stage-automatic.png') });
  // An approval stage is the owner's own step, so it has no automatic switches.
  await implement.getByRole('radio', { name: 'Approval', exact: true }).click();
  await expect(implement.getByRole('switch', { name: 'Approve plan', exact: true })).toHaveCount(0);
});

test('every control has an accessible name', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await demo(request);
  await openWorkflows(page);
  await page.getByTestId('workflow-row-demo-flow').click();
  const unnamed = await page.getByTestId('workflows-settings').evaluate((root) =>
    Array.from(root.querySelectorAll<HTMLElement>('button, input, textarea, select, [role="combobox"], [role="radio"], [role="switch"]'))
      .filter((el) => el.offsetParent !== null && !el.closest('[aria-hidden="true"]'))
      .filter((el) => {
        const labelled = el.getAttribute('aria-labelledby')?.split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join('');
        const forLabel = el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : '';
        const name = el.getAttribute('aria-label') || labelled || forLabel || el.closest('label')?.textContent || el.textContent || el.getAttribute('title');
        return !name?.trim();
      })
      .map((el) => el.outerHTML.slice(0, 120)));
  expect(unnamed, 'controls without a name').toEqual([]);
});

test('fits phone and desktop widths', async ({ page, request }) => {
  await demo(request);
  for (const [label, width, height] of [['phone', 375, 812], ['desktop', 1280, 800]] as const) {
    await page.setViewportSize({ width, height });
    await openWorkflows(page);
    await noSideScroll(page);
    await page.screenshot({ path: join(results, `${label}-list.png`) });
    await page.getByTestId('workflow-row-demo-flow').click();
    await expect(page.getByTestId('workflow-stage').first()).toBeVisible();
    await noSideScroll(page);
    await page.screenshot({ path: join(results, `${label}-editor.png`), fullPage: true });
  }
});

test('long names, a failed load and a blank stage name keep the layout', async ({ page, request }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const long = 'Implement, QA, integrate, open a pull request and merge every agent-ready Keystone ticket';
  const before = (await stored(request)).workflows;
  await seed(request, [...before, { id: 'long-one', name: long, enabled: false, trigger: { kind: 'manual' }, setup: {}, stages: [] }]);
  await openWorkflows(page);
  const row = page.getByTestId('workflow-row-long-one');
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  expect(box!.x + box!.width, 'the row stays on screen').toBeLessThanOrEqual(375);
  await noSideScroll(page);

  await row.click();
  await page.getByRole('button', { name: 'Add stage', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Stage name is required', { exact: true })).toBeVisible();

  await page.route(`**${api}?**`, (route) => route.fulfill({ status: 500, body: 'disk unavailable' }));
  await openWorkflows(page);
  await expect(page.getByText("Couldn't load workflows", { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await page.screenshot({ path: join(results, 'load-error.png') });
});

test('labels use standard wording', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await demo(request);
  await openWorkflows(page);
  // Every section's button is its label, then its hint.
  await expect(page.getByTestId('settings-section-workflows')).toHaveText(/^Workflows/);
  await page.getByTestId('workflow-row-demo-flow').click();
  const root = page.getByTestId('workflows-settings');
  for (const name of ['Save', 'Add stage', 'Add route']) await expect(root.getByRole('button', { name, exact: true }).first()).toBeVisible();
  for (const label of ['Name', 'Trigger', 'Stage name']) await expect(root.getByLabel(label, { exact: true }).first()).toBeVisible();
  const buttons = await root.getByRole('button').allInnerTexts();
  expect(buttons.filter((text) => /\.\s*$/.test(text.trim())), 'no button ends with a period').toEqual([]);
  await expect(root).not.toContainText(/What it does|When it applies|How it behaves|Where it lives|Please wait/);
});
