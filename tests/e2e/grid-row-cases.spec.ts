import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Cases before work, in the real app: the agent adds a cell's cases, Atelier
 * runs the coverage review (a fresh agent that sees only the column, the row
 * and the cases), the agent answers the gap it finds, and a clean review
 * readies the cell on its own. The owner approves nothing: there is no
 * approve_cases action and no Approve cases button.
 *
 * Run:
 *   CLAUDE_PATH="$PWD/tests/e2e/fixtures/fake-review-agent.mjs" \
 *   FAKE_REVIEW_AGENT_LOG="$WORKBENCH_E2E_RUN/review-agent.log" \
 *   scripts/workbench-e2e.sh tests/e2e/grid-row-cases.spec.ts
 */

const RUN = process.env.WORKBENCH_E2E_RUN!;
const DATABASE = join(process.env.ATELIER_DATA_DIR!, 'workbench.db');
const SHOTS = process.env.GRID_SHOTS;
const LOG = process.env.FAKE_REVIEW_AGENT_LOG ?? '';

const sql = (value: string) => `'${value.replaceAll("'", "''")}'`;
const backend = () => process.env.BEADS_E2E_BACKEND ?? '';

interface Project { id: string; path: string }

function template(col: string) {
  return {
    name: col, command: `atelier case camera/{row}/${col}/${col} -- cargo test {row}_${col}`, kind: 'test',
    given: 'the {row} pass', when: 'it runs', then: 'it works', red: `CASE camera/{row}/${col}/${col} FAIL`,
  };
}

function testCase(row: string, col: string, id: string, given: string) {
  return {
    id, given, when: 'the frame renders', then: 'the glare sits on the sun',
    command: `atelier case camera/${row}/${col}/${id} -- cargo test ${row}_${id.replaceAll('-', '_')}`,
    red: `CASE camera/${row}/${col}/${id} FAIL`,
  };
}

async function act(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.post(`${backend()}/api/workbench/grid`, { data });
  const text = await res.text();
  expect(res.ok(), `${String(data.action)}: ${text}`).toBeTruthy();
  return text;
}

function stepOf(row: string, col: string): string {
  return execFileSync('sqlite3', [DATABASE, `SELECT step FROM grid_cell WHERE slug = 'camera' AND row = ${sql(row)} AND col = ${sql(col)}`], { encoding: 'utf8' }).trim();
}

test('a row goes cases, review, ready with no owner step', async ({ page, request }) => {
  test.setTimeout(240_000);
  expect(LOG, 'start the run with FAKE_REVIEW_AGENT_LOG and CLAUDE_PATH set to the fake review agent').not.toBe('');
  rmSync(LOG, { force: true });
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });

  const path = join(RUN, 'grid-cases-project');
  rmSync(path, { recursive: true, force: true });
  mkdirSync(join(path, 'camera'), { recursive: true });
  writeFileSync(join(path, 'rows.sh'), [
    'echo \'{"id":"glare","name":"Glare","paths":["camera/glare.rs"]}\'',
    'echo \'{"id":"sunstar","name":"Sunstar","paths":["camera/sunstar.rs"]}\'',
  ].join('\n') + '\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: path });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'add', '-A'], { cwd: path });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'rows'], { cwd: path });

  const made = await request.post(`${backend()}/api/projects`, { data: { name: 'grid cases', path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as Project;

  const session = 'grid-cases-chat';
  const at = '2026-11-17T08:00:00.000Z';
  execFileSync('sqlite3', [DATABASE, `BEGIN IMMEDIATE;
    INSERT INTO session (id, brand, external_id, project_id, project_path, cwd, model, permission_mode, effort, title, state, origin, created_at, last_active_at)
      VALUES (${sql(session)}, 'claude', NULL, ${sql(project.id)}, ${sql(path)}, ${sql(path)}, 'claude-opus-5', 'default', NULL, 'Camera grid', 'dormant', 'app', ${sql(at)}, ${sql(at)});
    INSERT INTO message (session_id, message_id, role, text, at) VALUES (${sql(session)}, 'm0', 'user', '@matrix the camera area, secret-chat-words', ${sql(at)});
    COMMIT;`]);

  try {
    await act(request, {
      action: 'draft', actor: 'agent', session,
      payload: {
        slug: 'camera', title: 'Renderer camera', area: 'The camera features.',
        row_search: { command: 'sh rows.sh', watch: ['camera/'] },
        columns: [
          { id: 'gpu', name: 'Runs on the GPU', proof_rule: 'a GPU test that renders the effect', checks: [template('gpu')] },
          { id: 'perf', name: 'Within budget', proof_rule: 'a benchmark under the frame budget', checks: [template('perf')] },
        ],
      },
    });
    await act(request, { action: 'approve', actor: 'owner', project: project.id, slug: 'camera' });
    if (SHOTS) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`/project?id=${project.id}&tab=tasks&view=grids&grid=camera`);
      await page.getByTestId('grid-discovery').first().waitFor({ timeout: 60_000 });
      await page.waitForTimeout(1_000);
      await page.screenshot({ path: join(SHOTS, 'grid-approved.png') });
    }
    // No default order: every cell waits for the agent to write one.
    expect(stepOf('glare', 'gpu')).toBe('order');
    const cell = (col: string) => ({ actor: 'agent', session, slug: 'camera', row: 'glare', col });
    const early = await request.post(`${backend()}/api/workbench/grid`, { data: { action: 'cases', ...cell('gpu'), payload: { cases: [] } } });
    expect(early.ok()).toBeFalsy();
    expect(await early.text()).toContain('atelier grid order camera');
    const why = 'it shares the pass the others build on';
    await act(request, {
      action: 'order', actor: 'agent', session, slug: 'camera',
      payload: {
        rows: [{ id: 'glare', after: [], reason: why }, { id: 'sunstar', after: [], reason: why }],
        columns: [{ id: 'gpu', after: [], reason: why }, { id: 'perf', after: ['gpu'], reason: 'it measures the pass gpu draws' }],
      },
    });
    expect(stepOf('glare', 'gpu')).toBe('cases');

    // glare.gpu: one case, a gap found, a case added for it, a clean review.
    await act(request, { action: 'cases', ...cell('gpu'), payload: { cases: [testCase('glare', 'gpu', 'dark-room', 'glare in a dark room')] } });
    const first = await act(request, { action: 'review', ...cell('gpu') });
    expect(first).toContain('r1g1');
    expect(first).toContain('the sun low on the horizon');
    expect(stepOf('glare', 'gpu')).toBe('cases');
    await act(request, {
      action: 'cases', ...cell('gpu'),
      payload: { cases: [testCase('glare', 'gpu', 'dark-room', 'glare in a dark room'), { ...testCase('glare', 'gpu', 'low-sun', 'the sun at the horizon'), covers: 'r1g1' }] },
    });
    await act(request, { action: 'review', ...cell('gpu') });
    expect(stepOf('glare', 'gpu')).toBe('reviewed');

    // glare.perf: the gap is dismissed with a reason, then a clean review.
    await act(request, { action: 'cases', ...cell('perf'), payload: { cases: [testCase('glare', 'perf', 'dark-room', 'glare in a dark room')] } });
    await act(request, { action: 'review', ...cell('perf') });
    await act(request, { action: 'cases', ...cell('perf'), payload: { dismiss: { r1g1: 'covered by the gpu column' } } });
    await act(request, { action: 'review', ...cell('perf') });
    expect(stepOf('glare', 'perf')).toBe('reviewed');

    // The reviewer saw the column, the row and the cases, and nothing from the chat.
    const prompts = readFileSync(LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line).prompt as string);
    expect(prompts.length).toBe(4);
    expect(prompts[0]).toContain('Runs on the GPU');
    expect(prompts[0]).toContain('a GPU test that renders the effect');
    expect(prompts[0]).toContain('Glare');
    expect(prompts[0]).toContain('glare in a dark room');
    expect(prompts[0]).toContain('cargo test glare_gpu');
    for (const prompt of prompts) {
      expect(prompt).not.toContain('secret-chat-words');
      expect(prompt).not.toContain(session);
    }
    expect(prompts[3]).toContain('covered by the gpu column');

    // No one approves cases: not the agent, not the owner.
    for (const actor of ['agent', 'owner']) {
      const refused = await request.post(`${backend()}/api/workbench/grid`, { data: { action: 'approve_cases', actor, session, slug: 'camera', row: 'glare' } });
      expect(refused.ok()).toBeFalsy();
    }
    expect(stepOf('glare', 'gpu')).toBe('reviewed');
    expect(stepOf('glare', 'perf')).toBe('reviewed');
    expect(stepOf('sunstar', 'gpu')).toBe('cases');

    // The Grids screen asks the owner for nothing.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/project?id=${project.id}&tab=tasks&view=grids&grid=camera`);
    await page.getByTestId('grid-discovery').first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1_000);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'grid-reviewed.png') });
    await expect(page.getByTestId('grid-row-cases')).toHaveCount(0);
    await expect(page.getByTestId('grid-approve-cases')).toHaveCount(0);
    await expect(page.getByText('Approve cases')).toHaveCount(0);
  } finally {
    await request.delete(`${backend()}/api/projects/${project.id}`);
  }
});
