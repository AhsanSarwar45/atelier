/** Browser acceptance for every named Codex conversation held by another process. */
import { chromium } from '@playwright/test';

const app = process.env.BEADS_E2E_URL ?? 'http://127.0.0.1:3008';
const [project, ...sessions] = process.argv.slice(2);
if (!project || !sessions.length) throw new Error('usage: node scripts/codex-ownership-smoke.mjs <project> <external-session> [external-session ...]');

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const ownershipFrames = [];
  page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
    const text = String(payload);
    if (text.includes('\\"kind\\":\\"running\\"')) ownershipFrames.push(text);
  }));
  await page.goto(`${app}/project?id=${encodeURIComponent(project)}&tab=chat`);
  await page.locator('[data-testid="restore-row"]').first().waitFor({ timeout: 60_000 });
  const opened = [];
  for (const externalId of sessions) {
    const row = page.locator(`[data-testid="restore-row"][data-external-id="${externalId}"]`);
    try {
      await row.waitFor({ timeout: 10_000 });
      if (await row.getAttribute('data-running') !== 'yes') throw new Error('row says it is not running');
      await row.locator('[data-testid="chat-external"]').waitFor({ timeout: 10_000 });
      const priorKey = await row.getAttribute('data-row-key');
      await row.getByTestId('row-name').click();
      await page.locator('[data-testid="transcript"]').waitFor({ timeout: 30_000 });
      await page.locator('[data-testid="chat-tab"]').waitFor({ timeout: 30_000 });
      const internalId = await page.locator('[data-testid="chat-tab"]').getAttribute('data-session-id');
      if (!internalId) throw new Error('opened chat has no Atelier id');
      if (priorKey && !priorKey.startsWith('ext:') && internalId !== priorKey) {
        throw new Error(`row ${priorKey} opened ${internalId}`);
      }
      await page.locator('[data-testid="session-state"] [data-testid="chat-external"]').waitFor({ timeout: 10_000 });
      opened.push({ externalId, internalId });
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({
        url: location.href,
        state: document.querySelector('[data-testid="session-state"]')?.getAttribute('data-state') ?? null,
        external: document.querySelectorAll('[data-testid="chat-external"]').length,
      }));
      throw new Error(`External Codex chat ${externalId} failed its row/open audit: ${JSON.stringify({ ...diagnostic, ownershipFrames })}\n${error}`);
    }
  }
  console.log(`${opened.length}/${sessions.length} live Codex chats had external badges and opened their own Atelier sessions`);
} finally {
  await browser.close();
}
