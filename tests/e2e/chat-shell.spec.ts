import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The chat screen, as the owner meets it: how long he waits, what a row tells
 * him, and whether any of it is coloured.
 *
 * Needs an instance whose project has chats in it — the waiting only exists
 * when there is something to draw. Pick one with BEADS_E2E_PROJECT, or the
 * first the instance lists.
 *
 * Run: BEADS_E2E_URL=http://127.0.0.1:3021 BEADS_E2E_BACKEND=http://127.0.0.1:3008 \
 *      npx playwright test tests/e2e/chat-shell.spec.ts
 */

async function projectId(request: APIRequestContext): Promise<string> {
  if (process.env.BEADS_E2E_PROJECT) return process.env.BEADS_E2E_PROJECT;
  const api = process.env.BEADS_E2E_BACKEND ?? '';
  const projects = (await (await request.get(`${api}/api/projects`)).json()) as { id: string }[];
  expect(projects.length, 'the instance lists no projects').toBeGreaterThan(0);
  return projects[0].id;
}

/** Every colour the page draws, as the numbers a screen actually paints. */
async function paintedColour(page: Page, selector: string): Promise<{ text: number[]; fill: number[] }> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`nothing matched ${sel}`);
    const style = getComputedStyle(el);
    // Painted colours arrive in whatever space the browser resolved them to,
    // so they are read back through a canvas, which always answers in sRGB.
    const read = (value: string) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#000';
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!];
    };
    return { text: read(style.color), fill: read(style.backgroundColor) };
  }, selector);
}

/** How far apart the most and least of red, green and blue are. Grey is zero. */
function colourfulness([r, g, b]: number[]): number {
  return Math.max(r!, g!, b!) - Math.min(r!, g!, b!);
}

test.describe('the chat screen', () => {
  test('a chip on a chat is coloured, not the page\'s own grey', async ({ page, request }) => {
    const id = await projectId(request);
    await page.goto(`/project?id=${id}&tab=chat`);
    await page.getByTestId('row-folder-chip').first().waitFor();

    const chip = await paintedColour(page, '[data-testid="row-folder-chip"]');
    expect(colourfulness(chip.text), `the chip's words came out ${chip.text.join(',')}`).toBeGreaterThan(20);
    expect(colourfulness(chip.fill), `the chip's fill came out ${chip.fill.join(',')}`).toBeGreaterThan(4);
  });
});
