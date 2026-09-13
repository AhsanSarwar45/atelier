import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { aProjectOfItsOwn, command } from './fixture-held';

test('a provider left behind by a dropped driver is recovered as ours', async ({ page, request }) => {
  test.skip(!process.env.BEADS_E2E_ACP_DROP_ONCE, 'needs the ACP drop fixture');
  test.setTimeout(120_000);

  const project = await aProjectOfItsOwn(request, 'owned-orphan');
  try {
    const started = await command(request, {
      type: 'session.start',
      projectId: project.id,
      projectPath: project.path,
      brand: 'claude',
      title: 'Recover an owned provider',
    });
    expect(started.ok, started.body).toBe(true);
    const sessionId = started.said.id!;

    // The fixture drops its ACP stream on this first prompt and deliberately
    // leaves a token-bearing provider process behind.
    const dropped = await command(request, {
      type: 'prompt.send',
      sessionId,
      text: 'drop the driver',
    });
    expect(dropped.ok, dropped.body).toBe(true);
    const sentinel = process.env.BEADS_E2E_ACP_DROP_ONCE!;
    const orphanPid = await expect
      .poll(() => {
        try {
          return Number(readFileSync(sentinel, 'utf8').trim());
        } catch {
          return 0;
        }
      }, { timeout: 10_000 })
      .toBeGreaterThan(0)
      .then(() => Number(readFileSync(sentinel, 'utf8').trim()));
    await new Promise((settle) => setTimeout(settle, 750));

    // Resuming crosses the same ownership guard that produced the manager's
    // false “Another program” refusal. The registry must reap its own orphan,
    // attach once, and preserve the guard for genuinely outside processes.
    const resumed = await command(request, {
      type: 'session.resume',
      sessionId,
      brand: 'claude',
      projectId: project.id,
      projectPath: project.path,
    });
    expect(resumed.ok, `Atelier refused its own surviving provider: ${resumed.body}`).toBe(true);
    await expect.poll(() => {
      try {
        process.kill(orphanPid, 0);
        return true;
      } catch {
        return false;
      }
    }).toBe(false);

    const continued = await command(request, {
      type: 'prompt.send',
      sessionId,
      text: 'continue on the replacement driver',
    });
    expect(continued.ok, continued.body).toBe(true);

    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
    await page.goto(`/project?id=${project.id}&tab=chat&chat=${sessionId}`);
    await expect(page.getByTestId('composer')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('composer')).toBeEnabled();
    await expect(page.getByText('Another program has this chat open')).toHaveCount(0);
    await page.screenshot({
      path: 'tests/results/bw-8lbp-owned-orphan-recovered.png',
      animations: 'disabled',
    });

    await command(request, { type: 'session.stop', sessionId });
  } finally {
    await project.remove();
  }
});
