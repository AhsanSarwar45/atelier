import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * A chat is not offered a choice by being on it.
 *
 * A chat whose provider has not answered with its catalog still knows what it
 * is set to. The app used to draw a menu out of exactly that: one option, the
 * value it was already on, labelled with the wire's own spelling. So the effort
 * chip read `high` where every other chip reads `High` — the app has one place
 * that puts a level into words and an invented displayName went around it — and
 * opening the picker offered that single fabricated choice with the provider's
 * real levels nowhere in it (bw-l4fr.4, bw-l4fr.5).
 *
 * The chat is seeded straight into the store, carrying its pins on
 * `session.started` and no `session.menu` at all. That is the shape a chat read
 * off a provider record arrives in, and starting one through the app will not
 * reproduce it: `session.start` is answered with a real catalog, so the empty
 * menu this is about never happens on that path.
 */

const RUN = process.env.WORKBENCH_E2E_RUN!;
const DATABASE = join(process.env.ATELIER_DATA_DIR!, 'workbench.db');

/** Pinned on the chat, and offered to it by nothing. */
const EFFORT = 'high';
const MODE = 'bypassPermissions';

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function backend(): string {
  return process.env.BEADS_E2E_BACKEND ?? '';
}

interface Project {
  id: string;
  path: string;
}

async function proofProject(request: APIRequestContext): Promise<Project> {
  const path = join(RUN, 'a-pin-is-not-a-menu-project');
  mkdirSync(path, { recursive: true });
  const response = await request.post(`${backend()}/api/projects`, {
    data: { name: 'a pin is not a menu', path, isTest: true },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as Project;
}

/** A saved chat with its pins and no catalog anywhere. */
function seedChat(project: Project): string {
  const sessionId = 'a-pin-is-not-a-menu-chat';
  const at = '2026-09-01T08:00:00.000Z';
  const started = {
    type: 'session.started',
    sessionId,
    seq: 1,
    at,
    brand: 'claude',
    externalId: null,
    model: 'claude-opus-5',
    cwd: project.path,
    permissionMode: MODE,
    effort: EFFORT,
    collaborationMode: null,
  };
  const statements = [
    `INSERT INTO session
      (id, brand, external_id, project_id, project_path, cwd, model, permission_mode, effort, title, state, origin, created_at, last_active_at)
      VALUES (${sql(sessionId)}, 'claude', NULL, ${sql(project.id)}, ${sql(project.path)},
        ${sql(project.path)}, 'claude-opus-5', ${sql(MODE)}, ${sql(EFFORT)},
        'A chat whose catalog never came', 'dormant', 'app', ${sql(at)}, ${sql(at)});`,
    `INSERT INTO event (session_id, seq, at, type, json)
      VALUES (${sql(sessionId)}, 1, ${sql(at)}, 'session.started', ${sql(JSON.stringify(started))});`,
  ];
  execFileSync('sqlite3', [DATABASE, `BEGIN IMMEDIATE;\n${statements.join('\n')}\nCOMMIT;`]);
  return sessionId;
}

test.describe('a pin is not a menu', () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
  });

  test('a level no catalog offered is named in words, and offered by nothing', async ({ page, request }) => {
    const project = await proofProject(request);
    const chat = seedChat(project);

    await page.goto(`/project?id=${project.id}&tab=chat&chat=${chat}`);
    await page.getByTestId('chat-tab').waitFor({ timeout: 60_000 });

    const chip = page.getByTestId('chat-effort-chip');
    await expect.poll(() => chip.getAttribute('data-effort'), { timeout: 60_000 }).toBe(EFFORT);

    const shot = process.env.PIN_MENU_SHOT;
    if (shot) {
      await page.waitForTimeout(1_000);
      await page.getByTestId('chat-status-line').screenshot({ path: shot });
    }

    // The app has one place that puts a level into words and the chip goes
    // through it. `high` on the chip means something went around it.
    await expect(chip).toHaveText('High');

    // A picker with no options is absent by design. What must never appear is
    // one holding only the value the chat is already on.
    const picker = page.getByTestId('effort-picker');
    if (await picker.isVisible().catch(() => false)) {
      await picker.click();
      const options = page.getByTestId('effort-picker-option');
      await options.first().waitFor({ timeout: 10_000 });
      const values = await Promise.all(
        (await options.all()).map((option) => option.getAttribute('data-value')),
      );
      expect(
        values,
        `the effort picker offered only what the chat was already set to: ${JSON.stringify(values)}`,
      ).not.toEqual([EFFORT]);
    }
  });
});
