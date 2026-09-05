import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { discardFixture, makeFixtureProject } from './fixture-board';
import { raggedChatSaidWithPictures, writeLongChat, type LongChat } from './fixture-record';

/**
 * What a picture does to the row it is in, between arriving and being drawn.
 *
 * A picture in a chat is carried in the record itself, so nothing is fetched —
 * but nothing is decoded either until the browser gets to it, and until then an
 * `<img>` with no size on it is a row of no height at all. The row is measured
 * in that state, the chat believes the number, and a frame or two later the
 * picture appears and shoves everything under it down by a full screen. When
 * the row is above the reader, what it shoves is him.
 *
 * This is read at the one moment it cannot be raced: a picture is caught the
 * instant it enters the page, before any decoding can have happened, and what
 * it is holding open then is compared with what it holds open once it is drawn.
 * A reserved place is the same number twice.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/pictures-reserve-their-place.spec.ts
 */

const HELLO_MS = 120_000;

const HELD = 200;

const RUN = join(__dirname, '..', '.workbench-run-reserve');

const SHOTS = join(process.cwd(), 'tests', 'results');

interface Ground {
  projectId: string;
  chat: LongChat;
  away: () => Promise<void>;
}

async function makeGround(request: APIRequestContext): Promise<Ground> {
  const where = join(RUN, 'pictures');
  const project = join(where, 'project');
  discardFixture(where);
  mkdirSync(where, { recursive: true });
  makeFixtureProject(project, join(where, 'reporting'));
  // Unmarked on purpose: a project marked `isTest` is left out of
  // `GET /api/projects` and the project screen can then draw nothing at all
  // (bw-1cqk). It is deleted below.
  const made = await request.post('/api/projects', {
    data: { name: 'workbench-reserve', path: project },
  });
  expect(made.status(), await made.text()).toBe(201);
  const listed = (await made.json()) as { id: string };
  const chat = writeLongChat({
    cwd: project,
    sessionId: randomUUID(),
    held: HELD,
    said: raggedChatSaidWithPictures,
  });
  return {
    projectId: listed.id,
    chat,
    away: async () => {
      chat.remove();
      await request.delete(`/api/projects/${listed.id}`);
    },
  };
}

async function readChat(page: Page, ground: Ground): Promise<void> {
  await page.goto(`/project?id=${ground.projectId}&tab=chat`);
  await expect(page.getByTestId('chat-sidebar')).toBeVisible({ timeout: HELLO_MS });
  const row = page.locator(`[data-testid="restore-row"][data-external-id="${ground.chat.sessionId}"]`);
  await row.waitFor({ timeout: HELLO_MS });
  await row.getByTestId('row-name').click();
  await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
  await page.getByTestId('virtual-transcript').waitFor({ timeout: HELLO_MS });
  await page.waitForTimeout(2000);
}

/** What one picture held open when it arrived, and what it holds open now. */
interface Held {
  arrived: number;
  drawn: number;
  loaded: boolean;
}

/**
 * Watches for pictures entering the page and measures each one on the spot.
 *
 * A mutation observer runs before the browser has had a chance to decode
 * anything, so the height read here is the height the chat measures the row at.
 */
async function watchPictures(page: Page): Promise<void> {
  await page.evaluate(() => {
    const box = document.querySelector('[data-testid="transcript"]') as HTMLElement;
    const held = new Map<HTMLImageElement, number>();
    (window as unknown as { __held?: Map<HTMLImageElement, number> }).__held = held;
    const take = (node: Node): void => {
      if (!(node instanceof HTMLElement)) return;
      const pictures =
        node.matches('[data-testid="message-image"]')
          ? [node as HTMLImageElement]
          : [...node.querySelectorAll<HTMLImageElement>('[data-testid="message-image"]')];
      for (const picture of pictures) {
        if (!held.has(picture)) held.set(picture, picture.getBoundingClientRect().height);
      }
    };
    const watching = new MutationObserver((records) => {
      for (const record of records) record.addedNodes.forEach(take);
    });
    watching.observe(box, { childList: true, subtree: true });
    (window as unknown as { __watching?: MutationObserver }).__watching = watching;
  });
}

async function readPictures(page: Page): Promise<Held[]> {
  return page.evaluate(() => {
    const held = (window as unknown as { __held?: Map<HTMLImageElement, number> }).__held;
    (window as unknown as { __watching?: MutationObserver }).__watching?.disconnect();
    if (!held) throw new Error('no picture was being watched');
    const seen: { arrived: number; drawn: number; loaded: boolean }[] = [];
    held.forEach((arrived, picture) => {
      if (!picture.isConnected) return;
      seen.push({
        arrived: Math.round(arrived),
        drawn: Math.round(picture.getBoundingClientRect().height),
        loaded: picture.complete && picture.naturalHeight > 0,
      });
    });
    return seen;
  });
}

test.describe('a picture in an older message', () => {
  test.setTimeout(300_000);

  test('holds its place open from the moment it arrives', async ({ page, request }) => {
    const ground = await makeGround(request);
    try {
      await readChat(page, ground);
      await watchPictures(page);
      // Up to the top of what is loaded, which asks for the page before it. The
      // rows of that page arrive all at once, pictures and all, and every one of
      // them is measured in the frame it arrives in.
      for (let go = 0; go < 3; go += 1) {
        await page.evaluate(() => {
          const box = document.querySelector('[data-testid="transcript"]') as HTMLElement;
          box.scrollTop = 0;
        });
        await page.waitForTimeout(1500);
      }
      const seen = await readPictures(page);
      // eslint-disable-next-line no-console
      console.log('pictures held', JSON.stringify(seen));
      expect(seen.length, 'no picture was ever drawn, so nothing about pictures was proved').toBeGreaterThan(2);
      expect(
        seen.filter((p) => !p.loaded),
        `a picture never finished loading, so its drawn height means nothing: ${JSON.stringify(seen)}`,
      ).toEqual([]);
      expect(
        seen.filter((p) => Math.abs(p.arrived - p.drawn) > 2),
        `a picture arrived holding a different place than it ended up taking: ${JSON.stringify(seen)}`,
      ).toEqual([]);
      await page.screenshot({ path: join(SHOTS, 'bw-cdav-pictures-reserved.png') });
    } finally {
      await ground.away();
    }
  });
});
