import { expect, test } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Agent workbench end-to-end. Design: docs/agent-workbench.md.
 *
 * Drives a REAL Claude session through the app, so it needs:
 *   - a beads-server built from this worktree, with the workbench sidecar,
 *     reachable at BEADS_E2E_URL (default http://localhost:3008);
 *   - the terminal's own Claude sign-in. No API key is set or read.
 *
 * Run: BEADS_E2E_URL=http://127.0.0.1:3018 npx playwright test tests/e2e/workbench.spec.ts -g live-turn
 */

/** Kept out of Playwright's outputDir, which is wiped at the start of a run. */
const FIXTURE = join(__dirname, '..', '.workbench-run');
const SHOTS = join(__dirname, '..', 'results');

/**
 * Two sentences first so the answer visibly grows between screenshots, then an
 * edit so a permission card has to appear.
 */
const PROMPT =
  'In exactly two sentences, say what you are about to do. ' +
  'Then append a line saying HELLO to notes.txt using the Edit tool.';

test.describe('workbench', () => {
  test('live-turn streams an answer and asks permission', async ({ page, request }) => {
    // A real turn: model latency plus a tool round trip.
    test.setTimeout(300_000);

    rmSync(FIXTURE, { recursive: true, force: true });
    mkdirSync(FIXTURE, { recursive: true });
    writeFileSync(join(FIXTURE, 'notes.txt'), 'first line\n');
    mkdirSync(SHOTS, { recursive: true });

    // A project's path is unique, so a re-run reuses the row rather than
    // colliding with the one the previous run left behind.
    const existing = (await (await request.get('/api/projects')).json()) as { id: string; path: string }[];
    let project = existing.find((p) => p.path === FIXTURE);
    if (!project) {
      const created = await request.post('/api/projects', {
        data: { name: 'workbench-live', path: FIXTURE },
      });
      expect(created.status(), await created.text()).toBe(201);
      project = (await created.json()) as { id: string; path: string };
    }

    await page.goto(`/project?id=${project.id}`);
    await page.getByTestId('tab-chat').click();

    await page.getByTestId('new-chat').click();
    await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('composer').fill(PROMPT);
    await page.getByTestId('send-button').click();

    // ---- the streamed answer, caught mid-flight -------------------------
    const assistant = page.getByTestId('assistant-message').first();
    await expect(assistant).toBeVisible({ timeout: 90_000 });
    // Wait for real prose rather than the empty bubble the first delta creates.
    await expect.poll(async () => (await assistant.textContent())?.length ?? 0, { timeout: 90_000 }).toBeGreaterThan(20);

    const stop = page.getByTestId('stop-button');
    await expect(stop).toBeVisible();

    const textA = (await assistant.textContent()) ?? '';
    await page.screenshot({ path: join(SHOTS, 'live-turn-a.png'), fullPage: false });

    await expect
      .poll(async () => ((await assistant.textContent()) ?? '').length, { timeout: 60_000 })
      .toBeGreaterThan(textA.length);

    const textB = (await assistant.textContent()) ?? '';
    await page.screenshot({ path: join(SHOTS, 'live-turn-b.png'), fullPage: false });

    expect(textB.length).toBeGreaterThan(textA.length);
    expect(textB.startsWith(textA.slice(0, 20))).toBe(true);
    await expect(stop).toBeVisible();

    // ---- the permission card --------------------------------------------
    // Read-only tools are asked about too, so answer each card until the Edit
    // one arrives; that is the card the screenshots must show. Cards are
    // addressed by their own ask id, never by position — a second card
    // appearing must not shift what the assertions point at.
    let editAskId: string | null = null;
    for (let i = 0; i < 8 && editAskId === null; i++) {
      const open = page.locator('[data-testid="permission-card"][data-ask-state="open"]').first();
      await expect(open).toBeVisible({ timeout: 120_000 });
      const askId = await open.getAttribute('data-ask-id');
      const toolName = await open.getAttribute('data-tool-name');
      if (toolName && /^(Edit|Write|MultiEdit)$/.test(toolName)) {
        editAskId = askId;
        break;
      }
      await open.getByTestId('permission-allow_once').click();
      await expect(page.locator(`[data-ask-id="${askId}"]`)).toHaveAttribute('data-ask-state', 'resolved', {
        timeout: 60_000,
      });
    }
    expect(editAskId, 'an Edit permission card should appear').not.toBeNull();

    const editCard = page.locator(`[data-ask-id="${editAskId}"]`);
    await expect(editCard.getByTestId('permission-allow_once')).toHaveText('Allow once');
    await expect(editCard.getByTestId('permission-allow_always')).toHaveText('Allow always');
    await expect(editCard.getByTestId('permission-deny')).toHaveText('Deny');
    await editCard.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, 'permission-ask.png'), fullPage: false });

    await editCard.getByTestId('permission-allow_once').click();

    await expect(editCard).toHaveAttribute('data-ask-state', 'resolved', { timeout: 60_000 });
    await expect(editCard.getByTestId('permission-resolved')).toHaveText('Allowed');

    // The tool the card guarded must then actually run and finish.
    const editRow = page.locator('[data-testid="tool-row"][data-tool-name="Edit"]').last();
    await expect(editRow).toHaveAttribute('data-tool-status', 'ok', { timeout: 120_000 });

    await expect(page.getByTestId('cost-chip')).toBeVisible({ timeout: 180_000 });
    await editRow.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, 'permission-allowed.png'), fullPage: false });
  });
});
