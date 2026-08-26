/** Browser acceptance for a Codex conversation held by another process. */
import { chromium } from '@playwright/test';

const app = process.env.BEADS_E2E_URL ?? 'http://127.0.0.1:3008';
const [project, session] = process.argv.slice(2);
if (!project || !session) throw new Error('usage: node scripts/codex-ownership-smoke.mjs <project> <session>');

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const ownershipFrames = [];
  page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
    const text = String(payload);
    if (text.includes('\\"kind\\":\\"running\\"')) ownershipFrames.push(text);
  }));
  await page.goto(`${app}/project?id=${encodeURIComponent(project)}&tab=chat&chat=${encodeURIComponent(session)}`);
  await page.locator('[data-testid="transcript"]').waitFor({ timeout: 30_000 });
  try {
    await page.locator('[data-testid="chat-external"]').first().waitFor({ timeout: 10_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      url: location.href,
      model: document.querySelector('[data-testid="chat-model-chip"]')?.textContent?.trim() ?? null,
      composer: Boolean(document.querySelector('[data-testid="composer-frame"]')),
      held: document.querySelector('[data-testid="held-elsewhere"]')?.textContent?.trim() ?? null,
      state: document.querySelector('[data-testid="session-state"]')?.getAttribute('data-state') ?? null,
      external: document.querySelectorAll('[data-testid="chat-external"]').length,
    }));
    throw new Error(`External badge missing: ${JSON.stringify({ ...diagnostic, ownershipFrames })}\n${error}`);
  }
  await page.locator('[data-testid="held-elsewhere"]').waitFor();
  if (await page.locator('[data-testid="composer-frame"]').count()) throw new Error('externally held chat still offers a composer');
  const model = (await page.locator('[data-testid="chat-model-chip"]').first().innerText()).trim();
  if (/^gpt[-_]/i.test(model) || model.includes('-')) throw new Error(`raw model id is visible: ${model}`);
  console.log(`External badge shown; composer withheld; model shown as "${model}"`);
} finally {
  await browser.close();
}
