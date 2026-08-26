#!/usr/bin/env node
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:3007';
const screenshot = process.argv[3] ?? '/tmp/atelier-reasoning-effort.png';
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByText('Atelier', { exact: true }).nth(1).click();
  await page.getByTestId('tab-chat').click();
  await page.getByTestId('agent-codex').click();
  await page.getByTestId('new-chat').click();

  const picker = page.getByTestId('effort-picker');
  await picker.waitFor();
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-testid="effort-picker"]');
    return Boolean(element?.getAttribute('data-current'));
  });

  const effort = await picker.getAttribute('data-current');
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(`reasoning effort: ${effort}`);
  console.log(`screenshot: ${screenshot}`);
} finally {
  await browser.close();
}
