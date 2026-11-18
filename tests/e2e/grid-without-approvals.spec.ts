import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * A grid asks the owner for nothing, in the real app: an agent's draft is a
 * live grid at once, its checks change at once, and N/A is set at once. The
 * Grids screen and the waiting bar show no Approve, Discard or N/A buttons.
 *
 * Run:
 *   scripts/workbench-e2e.sh tests/e2e/grid-without-approvals.spec.ts
 */

const RUN = process.env.WORKBENCH_E2E_RUN!;
const DATABASE = join(process.env.ATELIER_DATA_DIR!, 'workbench.db');
const SHOTS = process.env.GRID_SHOTS;

const sql = (value: string) => `'${value.replaceAll("'", "''")}'`;
const backend = () => process.env.BEADS_E2E_BACKEND ?? '';

interface Project { id: string; path: string }

function template(col: string, suffix = '') {
  return {
    name: col, command: `atelier case camera/{row}/${col}/${col} -- cargo test {row}_${col}${suffix}`, kind: 'test',
    given: 'the {row} pass', when: 'it runs', then: 'it works', red: `CASE camera/{row}/${col}/${col} FAIL`,
  };
}

async function act(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.post(`${backend()}/api/workbench/grid`, { data });
  const text = await res.text();
  expect(res.ok(), `${String(data.action)}: ${text}`).toBeTruthy();
  return text;
}

function query(text: string): string {
  return execFileSync('sqlite3', [DATABASE, text], { encoding: 'utf8' }).trim();
}

test('a grid is live, changed and marked N/A with no owner step', async ({ page, request }) => {
  test.setTimeout(180_000);
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });

  const path = join(RUN, 'grid-no-approvals-project');
  rmSync(path, { recursive: true, force: true });
  mkdirSync(join(path, 'camera'), { recursive: true });
  writeFileSync(join(path, 'rows.sh'), [
    'echo \'{"id":"glare","name":"Glare","paths":["camera/glare.rs"]}\'',
    'echo \'{"id":"sunstar","name":"Sunstar","paths":["camera/sunstar.rs"]}\'',
  ].join('\n') + '\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: path });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'add', '-A'], { cwd: path });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'rows'], { cwd: path });

  const made = await request.post(`${backend()}/api/projects`, { data: { name: 'grid no approvals', path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as Project;

  const session = 'grid-no-approvals-chat';
  const at = '2026-11-18T08:00:00.000Z';
  execFileSync('sqlite3', [DATABASE, `BEGIN IMMEDIATE;
    INSERT INTO session (id, brand, external_id, project_id, project_path, cwd, model, permission_mode, effort, title, state, origin, created_at, last_active_at)
      VALUES (${sql(session)}, 'claude', NULL, ${sql(project.id)}, ${sql(path)}, ${sql(path)}, 'claude-opus-5', 'default', NULL, 'Camera grid', 'dormant', 'app', ${sql(at)}, ${sql(at)});
    INSERT INTO message (session_id, message_id, role, text, at) VALUES (${sql(session)}, 'm0', 'user', 'map the camera area', ${sql(at)});
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
    // The draft is live: its cells exist with no owner answer.
    expect(query(`SELECT COUNT(*) FROM grid_cell WHERE slug = 'camera'`)).toBe('4');

    // New checks apply at once.
    await act(request, { action: 'checks', actor: 'agent', session, slug: 'camera', payload: { columns: [{ id: 'gpu', checks: [template('gpu', '_v2')] }] } });
    expect(query(`SELECT COUNT(*) FROM grid_column WHERE slug = 'camera' AND id = 'gpu' AND checks LIKE '%_gpu_v2%'`)).toBe('1');

    // N/A is set at once.
    await act(request, { action: 'na', actor: 'agent', session, slug: 'camera', row: 'sunstar', col: 'perf', payload: { reason: 'sunstar has no frame cost' } });
    expect(query(`SELECT state FROM grid_cell WHERE slug = 'camera' AND row = 'sunstar' AND col = 'perf'`)).toBe('na');

    // The screens ask the owner for nothing.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/project?id=${project.id}&tab=tasks&view=grids`);
    await page.getByTestId('grid-list-row').first().waitFor({ timeout: 60_000 });
    await expect(page.getByTestId('grid-awaiting')).toHaveCount(0);
    await page.goto(`/project?id=${project.id}&tab=tasks&view=grids&grid=camera`);
    await page.getByTestId('grid-discovery').first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1_000);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'grid-live.png') });
    for (const id of ['grid-pending', 'grid-approve', 'grid-discard', 'cell-approve-na', 'cell-reject-na']) {
      await expect(page.getByTestId(id)).toHaveCount(0);
    }
    await expect(page.getByText('Awaiting approval')).toHaveCount(0);
  } finally {
    await request.delete(`${backend()}/api/projects/${project.id}`);
  }
});
