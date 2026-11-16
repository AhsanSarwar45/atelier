import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * The grid card in the real app (task #49): a grid drafted with a row search
 * and approved says when its search ran, and a `grid change` waiting for the
 * owner shows each column's checks, names what it adds and removes, and marks
 * the new column. Screens go to GRID_SHOTS when it is set.
 */

const RUN = process.env.WORKBENCH_E2E_RUN!;
const DATABASE = join(process.env.ATELIER_DATA_DIR!, 'workbench.db');
const SHOTS = process.env.GRID_SHOTS;

const sql = (value: string) => `'${value.replaceAll("'", "''")}'`;
const backend = () => process.env.BEADS_E2E_BACKEND ?? '';

interface Project { id: string; path: string }

function check(name: string, command: string) {
  return { name, command, kind: 'test', given: 'the {row} pass', when: 'it runs', then: 'it works', red: 'FAILED', files: ['rows.sh'] };
}

async function act(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.post(`${backend()}/api/workbench/grid`, { data });
  expect(res.ok(), `${String(data.action)}: ${await res.text()}`).toBeTruthy();
}

test('the grid card shows checks, names and the row search', async ({ page, request }) => {
  test.setTimeout(180_000);
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });

  const path = join(RUN, 'grid-card-project');
  rmSync(path, { recursive: true, force: true });
  mkdirSync(join(path, 'camera'), { recursive: true });
  writeFileSync(join(path, 'rows.sh'), [
    'echo \'{"id":"glare","name":"Glare","paths":["camera/glare.rs"]}\'',
    'echo \'{"id":"sunstar","name":"Sunstar","paths":["camera/sunstar.rs"]}\'',
  ].join('\n') + '\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: path });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'add', '-A'], { cwd: path });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'rows'], { cwd: path });

  const made = await request.post(`${backend()}/api/projects`, { data: { name: 'grid card', path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as Project;

  const session = 'grid-card-chat';
  const at = '2026-11-16T08:00:00.000Z';
  execFileSync('sqlite3', [DATABASE, `BEGIN IMMEDIATE;
    INSERT INTO session (id, brand, external_id, project_id, project_path, cwd, model, permission_mode, effort, title, state, origin, created_at, last_active_at)
      VALUES (${sql(session)}, 'claude', NULL, ${sql(project.id)}, ${sql(path)}, ${sql(path)}, 'claude-opus-5', 'default', NULL, 'Camera grid', 'dormant', 'app', ${sql(at)}, ${sql(at)});
    INSERT INTO message (session_id, message_id, role, text, at) VALUES (${sql(session)}, 'm0', 'user', '@matrix the camera area', ${sql(at)});
    COMMIT;`]);

  try {
    await act(request, {
      action: 'draft', actor: 'agent', session,
      payload: {
        slug: 'camera', title: 'Renderer camera', area: 'The camera features.',
        row_search: { command: 'sh rows.sh', watch: ['camera/'] },
        columns: [{ id: 'gpu', name: 'Runs on the GPU', proof_rule: 'a GPU test', checks: [check('gpu', 'cargo test gpu_{row}')] }],
      },
    });
    await act(request, { action: 'approve', actor: 'owner', project: project.id, slug: 'camera' });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/project?id=${project.id}&tab=tasks&view=grids&grid=camera`);
    const header = page.getByTestId('grid-discovery').first();
    await header.waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1_000);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'grid-header.png') });
    await expect.soft(page.getByText('Row search not run yet')).toHaveCount(0);

    await act(request, {
      action: 'change', actor: 'agent', session, slug: 'camera',
      payload: {
        addColumns: [{ id: 'scenes', name: 'Saved scenes', checks: [check('scenes', 'python scripts/scenes.py {row}')] }],
        removeRows: ['sunstar'],
      },
    });
    await page.reload();
    const draft = page.getByTestId('grid-draft').first();
    await draft.waitFor({ timeout: 60_000 });
    await draft.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1_000);
    if (SHOTS) await draft.screenshot({ path: join(SHOTS, 'edit-card-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1_000);
    await draft.scrollIntoViewIfNeeded();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'edit-card-phone.png'), fullPage: false });

    const diff = page.getByTestId('grid-draft-diff').first();
    await expect.soft(diff).toContainText('Columns added: Saved scenes');
    await expect.soft(diff).toContainText('Sunstar');
    await expect.soft(draft).toContainText('python scripts/scenes.py {row}');
    await expect.soft(draft).toContainText('New');
  } finally {
    await request.delete(`${backend()}/api/projects/${project.id}`);
  }
});
