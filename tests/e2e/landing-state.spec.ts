import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixtureProject, bd, discardFixture } from './fixture-board';

test('landed and nested work agree across the board and detail', async ({ page, request }) => {
  test.setTimeout(420_000);
  await page.setViewportSize({ width: 2200, height: 1000 });
  const run = join(process.cwd(), 'tests/.e2e-run-bw-9vv9/fixture');
  const path = makeFixtureProject(join(run, 'project'), join(run, 'reports'));
  bd(['config','set','status.custom','in_review,manager_review'], path);
  bd(['update', 'wl-demo1', '--title', 'Partially landed job', '--status', 'in_progress'], path);
  bd(['create', '--id', 'wl-done', '--title', 'Fully landed job', '--type', 'epic'], path);
  bd(['create', '--id', 'wl-done.1', '--title', 'Landed implementation'], path);
  bd(['update', 'wl-done.1', '--parent', 'wl-done'], path);
  bd(['close', 'wl-done.1', '--reason', 'Fixture landed work'], path);
  bd(['create', '--id', 'wl-nested', '--title', 'Nested active job', '--type', 'epic'], path);
  bd(['create', '--id', 'wl-nested.1', '--title', 'Nested phase', '--type', 'epic'], path);
  bd(['create', '--id', 'wl-nested.1.1', '--title', 'Active implementation'], path);
  bd(['update', 'wl-nested.1', '--parent', 'wl-nested'], path);
  bd(['update', 'wl-nested.1.1', '--parent', 'wl-nested.1'], path);
  bd(['update', 'wl-nested.1.1', '--status', 'in_progress'], path);
  const made = await request.post('/api/projects', { data: { name: 'Landing lifecycle proof', path } });
  expect(made.status(), await made.text()).toBe(201);
  const project = await made.json();
  const url = `/project?id=${project.id}&tab=board`;
  const phase = process.env.LIFECYCLE_PHASE ?? 'after';
  const output = join(process.cwd(), 'tests/results/landing-state');
  mkdirSync(output, { recursive: true });
  try {
    await page.goto(url);
    await expect(page.getByText('Partially landed job', { exact: true }).first()).toBeVisible({timeout: 60_000});
    if (phase === 'after') {
      const beads = await request.get(`/api/beads?path=${encodeURIComponent(path)}`);
      const data = await beads.json();
      writeFileSync(join(output, 'api.json'), JSON.stringify(data, null, 2));
      const states = Object.fromEntries(data.beads.map((b: {id:string;status:string}) => [b.id,b.status]));
      expect(states['wl-demo1']).toBe('in_progress');
      expect(states['wl-done']).toBe('closed');
      expect(states['wl-nested']).toBe('in_progress');
      expect(states['wl-nested.1']).toBe('in_progress');
      const refused = await request.patch('/api/beads/update', {data:{path,id:'wl-kid2',status:'closed'}});
      expect(refused.status()).toBe(409);
      expect(await refused.text()).toContain('lands');
      const forced = await request.post('/api/bd/command', {data:{cwd:path,args:['close','wl-kid2','--force']}});
      expect(forced.status()).toBe(409);
    }
    const captureEnv = { ...process.env };
    delete captureEnv.ATELIER_PRESENTATION_MEDIA_DIR;
    delete captureEnv.ATELIER_PRESENTATION_EPHEMERAL;
    const shot = join(output, `${phase}.png`);
    await page.screenshot({ path: shot, animations: 'disabled' });
    const capture = execFileSync('atelier', ['tool', 'screen-check', 'capture', '--type', 'image', '--target', shot], { env: captureEnv, encoding: 'utf8', timeout: 120_000 });
    writeFileSync(join(output, `${phase}.json`), capture);
    console.log(capture);
    if (phase === 'after') {
      await page.locator('[data-bead-id="wl-demo1"]').first().click();
      const detail = page.getByTestId('bead-detail');
      await expect(detail).toBeVisible();
      await expect(detail.getByTestId('derived-status')).toContainText('In Progress');
      await page.screenshot({path:join(output,'detail-after.png'),animations:'disabled'});
      await page.getByTestId('bead-detail-close').click();
      // Reopening a landed descendant reaches its ancestors in the next full snapshot.
      const reopened = await request.patch('/api/beads/update',{data:{path,id:'wl-done.1',status:'in_progress'}});
      expect(reopened.ok()).toBeTruthy();
      await expect.poll(async () => {
        const data = await (await request.get(`/api/beads?path=${encodeURIComponent(path)}`)).json();
        return data.beads.find((b:{id:string}) => b.id === 'wl-done')?.status;
      }).toBe('in_progress');
      await page.locator('[data-bead-id="wl-done"]').first().click();
      await expect(detail.getByTestId('derived-status')).toContainText('In Progress');
      await page.getByTestId('bead-detail-close').click();
      // A manager approves the exact proposed tree before delivery, never by forcing Done.
      const tree = execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:path,encoding:'utf8'}).trim();
      const commit = execFileSync('git',['rev-parse','HEAD'],{cwd:path,encoding:'utf8'}).trim();
      bd(['create','--id','wl-approval','--title','Change awaiting your approval'],path);
      bd(['update','wl-approval','--status','manager_review','--set-metadata',`manager_review_tree=${tree}`,'--set-metadata',`manager_review_commit=${commit}`],path);
      await request.patch('/api/beads/update',{data:{path,id:'wl-approval',title:'Change awaiting your approval'}});
      await page.reload();
      await page.getByText('Change awaiting your approval',{exact:true}).first().click();
      await expect(page.getByRole('button',{name:'Approve reviewed change'})).toBeVisible({timeout:30_000});
      await page.screenshot({path:join(output,'approval-after.png'),animations:'disabled'});
      await page.getByRole('button',{name:'Approve reviewed change'}).click();
      await expect(page.getByRole('button',{name:'Approve reviewed change'})).toBeHidden();
      const approved = await (await request.get(`/api/beads?path=${encodeURIComponent(path)}`)).json();
      const card = approved.beads.find((b:{id:string}) => b.id === 'wl-approval');
      expect(card.metadata.manager_approved_tree).toBe(tree);
      expect(card.status).toBe('manager_review');
    }
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    discardFixture(run);
  }
});
