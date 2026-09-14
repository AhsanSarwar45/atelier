import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * The finished settings and project settings screens at 375 and 1280 wide
 * (bw-2t1c.12). Every shot lands in tests/results/settings-proof/.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/settings-proof.spec.ts
 */

const results = 'tests/results/settings-proof';

test.beforeAll(() => {
  mkdirSync(results, { recursive: true });
});

const SIZES = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'desktop', width: 1280, height: 800 },
];

for (const size of SIZES) {
  test(`settings at ${size.width} wide`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto('/settings');
    await expect(page.getByTestId('settings-section-claude')).toBeVisible();
    await page.screenshot({ path: join(results, `${size.name}-settings-list.png`) });
    await page.goto('/settings?section=claude');
    await expect(page.getByTestId('provider-settings-claude-defaults')).toBeVisible();
    await page.screenshot({ path: join(results, `${size.name}-settings-claude.png`) });
    await page.goto('/settings?section=claude&tab=mcp');
    await expect(page.getByTestId('mcp-servers-claude')).toBeVisible();
    await page.screenshot({ path: join(results, `${size.name}-settings-mcp.png`) });
    await page.goto('/settings?section=accounts');
    await expect(page.getByTestId('accounts-settings')).toBeVisible();
    await page.screenshot({ path: join(results, `${size.name}-settings-accounts.png`) });
  });

  test(`project settings at ${size.width} wide`, async ({ page, request }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    const repo = mkdtempSync(join(tmpdir(), 'atelier-settings-proof-'));
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    const made = await request.post('/api/projects', { data: { name: 'Proof', path: repo } });
    expect(made.status(), await made.text()).toBe(201);
    const { id } = (await made.json()) as { id: string };
    try {
      await page.goto(`/project?id=${id}&settings=project`);
      await expect(page.getByTestId('project-general')).toBeVisible();
      await page.screenshot({ path: join(results, `${size.name}-project-general.png`) });
      await page.goto(`/project?id=${id}&settings=codex`);
      await expect(page.getByTestId('provider-settings-codex-defaults')).toBeVisible();
      await page.screenshot({ path: join(results, `${size.name}-project-codex.png`) });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
}
