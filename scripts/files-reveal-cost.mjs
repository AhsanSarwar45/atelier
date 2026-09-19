/**
 * What it costs to reveal a file the tree has not read its way down to yet.
 *
 * Opens a deep path straight from the address — the shape of every "open this
 * file" link in the app — and counts the journeys the tree makes to find it,
 * with the directory answers deliberately slowed so an order that waits shows
 * up as time rather than as luck.
 *
 *   BEADS_E2E_URL=http://127.0.0.1:3411 SLOW_TREE_MS=200 node scripts/files-reveal-cost.mjs <projectId> <absolute file> ...
 */
import { chromium } from '@playwright/test';

const APP = process.env.BEADS_E2E_URL ?? 'http://127.0.0.1:3411';
const SLOW = Number(process.env.SLOW_TREE_MS ?? 200);
const [projectId, ...paths] = process.argv.slice(2);
if (!projectId || !paths.length) throw new Error('usage: <projectId> <absolute file> ...');

for (const path of paths) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const trees = [];
  await page.route('**/api/fs/tree**', async (route) => {
    const dir = decodeURIComponent(new URL(route.request().url()).searchParams.get('dir') ?? '');
    trees.push({ dir, at: Date.now() });
    await new Promise((go) => setTimeout(go, SLOW));
    await route.continue();
  });

  const from = Date.now();
  await page.goto(`${APP}/project?id=${projectId}&tab=files&file=${encodeURIComponent(path)}`,
    { waitUntil: 'commit' });
  await page.waitForFunction(
    (n) => {
      const rows = [...document.querySelectorAll('[data-testid="files-tree-row"]')];
      return rows.some((r) => (r.textContent ?? '').trim() === n && r.getAttribute('aria-selected') === 'true');
    },
    path.split('/').pop(), { timeout: 60_000 },
  ).catch(() => console.log('  (the row was never marked as the chosen one)'));
  const drew = Date.now() - from;

  const levels = path.replace(/^.*?beads-web\//, '').split('/').length - 1;
  console.log(`${path.split('/').slice(-3).join('/')}  ${levels} folders deep`);
  console.log(`  revealed after ${drew}ms with each folder answered in ${SLOW}ms`);
  console.log(`  ${trees.length} tree calls: ${trees.map((t, i) =>
    `${i ? `+${t.at - trees[i - 1].at}ms ` : ''}${t.dir.split('/').slice(-1)[0] || '/'}`).join(', ')}`);
  await browser.close();
}
