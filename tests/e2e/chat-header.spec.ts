import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The line above a conversation, on a screen with both columns open.
 *
 * It carries what the chat is, where it is running, how full it is, what it has
 * spent and how much of the account's allowance is left — and it must carry all
 * of that in one line's height without anything drawing over anything else.
 *
 * It is measured rather than looked at, because the way this line failed leaves
 * every box in the right place: a chip squeezed under its own text keeps its
 * position and spills the words sideways over its neighbour, so a picture shows
 * two names on top of each other while the rectangles are all still in a row
 * (bw-7ks.22.15). Hence both readings — where the boxes are, and whether each
 * one still holds its own words.
 *
 * It runs on the isolated stack because it needs a chat with real numbers on
 * it: what a chat is using, what it cost and what the account has left only
 * exist once an agent has answered something.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/chat-header.spec.ts
 */

/** Where a run leaves its proof. */
const SHOTS = 'tests/results';

/** Starting an agent is a process launch. */
const HELLO_MS = 120_000;

/** One word, from a cold agent. */
const ANSWER_MS = 180_000;

/** A folder of its own, so this case never runs an agent in someone's work. */
const FIXTURE = join(__dirname, '..', '.workbench-run-header');

/** The width this is claimed at, with a column down each side. */
const SCREEN = { width: 1440, height: 900 };

/** Rounding in the browser's own numbers, not a gap anyone can see. */
const HAIR = 0.5;

/** Everything the line draws, in the order it draws it. */
const PIECES = [
  'session-state',
  'session-meta',
  'chat-folder-chip',
  'context-chip',
  'cost-chip',
  'plan-chips',
] as const;

/** The pieces that must never lose a character: a half-drawn number is a lie. */
const WHOLE = PIECES.filter((p) => p !== 'session-meta');

type Piece = { name: string; left: number; right: number; wants: number; has: number };

/**
 * A project of this run's own, marked as a test project so it stays off the
 * owner's dashboard and is swept up rather than living on his machine.
 */
async function fixtureProject(request: APIRequestContext): Promise<{ id: string; path: string }> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as {
    id: string;
    path: string;
  }[];
  const found = listed.find((p) => p.path === FIXTURE);
  if (found) return found;
  const made = await request.post('/api/projects', {
    data: { name: 'workbench-header', path: FIXTURE, isTest: true },
  });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

test.describe('the line above a conversation', () => {
  test.use({ viewport: SCREEN });
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    rmSync(FIXTURE, { recursive: true, force: true });
    mkdirSync(FIXTURE, { recursive: true });
  });

  /**
   * A test project is left off the plain list, which is the list the project
   * page itself reads — so this page asks for them too, and a real visitor
   * typing the same address still sees none (as workbench.spec.ts does).
   */
  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
  });

  test('holds every number it carries without drawing over itself', async ({ page, request }) => {
    const project = await fixtureProject(request);
    const started = (await (
      await request.post('/api/workbench/command', {
        data: {
          type: 'session.start',
          projectId: project.id,
          projectPath: project.path,
          brand: 'claude',
          permissionMode: 'bypassPermissions',
        },
      })
    ).json()) as { id: string };

    await page.goto(`/project?id=${project.id}&tab=chat&chat=${started.id}`);
    await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });

    // One word back, which is what puts numbers on the line: what the chat is
    // using, what it has spent, and what the account has left.
    const asked = await request.post('/api/workbench/command', {
      data: { type: 'prompt.send', sessionId: started.id, text: 'Reply with the single word OK and nothing else.' },
    });
    expect(asked.ok(), `the chat would not take the prompt: ${asked.status()}`).toBe(true);
    await page.getByTestId('context-chip').waitFor({ timeout: ANSWER_MS });

    // Both columns open, because that is the screen this is claimed at: the
    // line has the least room when the conversation has the least room.
    await expect(page.getByTestId('chat-right-rail')).toHaveAttribute('data-open', 'true');
    await expect(page.getByTestId('chat-sidebar')).toBeVisible();

    const line = page.getByTestId('chat-status-line');
    const room = (await line.boundingBox())!;
    const drawn: Piece[] = await line.evaluate((el, names) => {
      const out: Piece[] = [];
      for (const name of names) {
        const found = el.querySelector(`[data-testid="${name}"]`) as HTMLElement | null;
        if (!found) continue;
        const box = found.getBoundingClientRect();
        out.push({ name, left: box.left, right: box.right, wants: found.scrollWidth, has: found.clientWidth });
      }
      return out;
    }, [...PIECES]);

    const there = new Set(drawn.map((p) => p.name));
    for (const must of ['session-meta', 'chat-folder-chip', 'context-chip', 'plan-chips']) {
      expect(there.has(must), `the line drew no ${must}, so this proves nothing about it`).toBe(true);
    }

    // Nothing on top of anything: each piece starts where the last one ended.
    for (let i = 1; i < drawn.length; i += 1) {
      const before = drawn[i - 1]!;
      const now = drawn[i]!;
      expect(
        now.left,
        `${now.name} starts at ${now.left} — ${before.name} is still going at ${before.right}`,
      ).toBeGreaterThanOrEqual(before.right - HAIR);
    }

    // And nothing hanging off the end of the line, where it is simply cut.
    for (const piece of drawn) {
      expect(piece.right, `${piece.name} runs past the end of the line`).toBeLessThanOrEqual(
        room.x + room.width + HAIR,
      );
    }

    // Every chip still holds its own words. This is the reading the failure was
    // hiding behind: the box stays put and the text walks out of it.
    for (const piece of drawn.filter((p) => WHOLE.includes(p.name as (typeof WHOLE)[number]))) {
      expect(piece.wants, `${piece.name} is drawn ${piece.has}px wide and needs ${piece.wants}px`).toBeLessThanOrEqual(
        piece.has + 1,
      );
    }

    await page.screenshot({ path: `${SHOTS}/chat-status-line.png`, clip: { ...room } });

    await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId: started.id } });
  });
});
