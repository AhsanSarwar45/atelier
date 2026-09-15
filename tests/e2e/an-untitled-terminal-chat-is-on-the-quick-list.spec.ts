/**
 * A chat begun in a terminal with no title is on the quick list too.
 *
 * The chat list draws a quick answer from the app's own database first, then
 * the full one once provider discovery finishes. The quick answer used to
 * leave out any saved chat that had no title, no recorded message and was not
 * started in the app — which is every untitled terminal chat. The full answer
 * shows them, so they vanished on every refresh and came back (bw-og6k).
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/an-untitled-terminal-chat-is-on-the-quick-list.spec.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { discardFixture, makeFixtureProject } from './fixture-board';
import { configDir, projectSlug } from './fixture-record';

const SHOTS = 'tests/results';
const LISTED_MS = 120_000;
const RUN = join(__dirname, '..', '.workbench-run-untitled');
const PROJECT = join(RUN, 'project');

type Row = { externalId: string | null; sessionId: string | null; title: string | null };

/** A terminal chat's record with no title of any kind in it. */
function writeUntitledChat(cwd: string, sessionId: string, at: Date): () => void {
  const dir = join(configDir(), 'projects', projectSlug(cwd));
  const path = join(dir, `${sessionId}.jsonl`);
  mkdirSync(dir, { recursive: true });
  const line = (n: number, extra: Record<string, unknown>) => ({
    sessionId,
    cwd,
    gitBranch: 'main',
    version: '2.1.237',
    userType: 'external',
    timestamp: new Date(at.getTime() + n * 1000).toISOString(),
    parentUuid: n === 1 ? null : `untitled-${sessionId}-u${n - 1}`,
    uuid: `untitled-${sessionId}-u${n}`,
    ...extra,
  });
  const rows = [
    // A command's output, not a prompt, so discovery has nothing to name it by.
    line(1, { type: 'user', message: { role: 'user', content: '<local-command-stdout>ok</local-command-stdout>' } }),
    line(2, {
      type: 'assistant',
      message: { id: `msg_untitled_${sessionId}`, model: 'claude-opus-5', role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] },
    }),
  ];
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  utimesSync(path, at, at);
  return () => rmSync(path, { force: true });
}

async function projectAt(request: APIRequestContext, path: string): Promise<{ id: string }> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as { id: string; path: string }[];
  const found = listed.find((p) => p.path === path);
  if (found) return found;
  const made = await request.post('/api/projects', { data: { name: 'workbench-untitled', path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string };
}

test.describe('the quick chat list', () => {
  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    discardFixture(RUN);
    mkdirSync(RUN, { recursive: true });
  });
  test.describe.configure({ timeout: 300_000 });

  test('holds an untitled chat begun in a terminal, as the full list does', async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    makeFixtureProject(PROJECT, join(RUN, 'reporting'));
    const project = await projectAt(request, PROJECT);
    const chat = randomUUID();
    const when = new Date();
    when.setDate(when.getDate() - 6);
    const remove = writeUntitledChat(PROJECT, chat, when);

    const restore = async (local: boolean): Promise<Row[]> => {
      const q = new URLSearchParams({ project: project.id, path: PROJECT });
      if (local) q.set('local', '1');
      return (await (await request.get(`/api/workbench/restore?${q}`)).json()) as Row[];
    };

    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });

    try {
      // The full answer finds the chat on disk and saves it.
      await expect
        .poll(async () => (await restore(false)).find((r) => r.externalId === chat), { timeout: LISTED_MS })
        .toBeTruthy();
      const full = (await restore(false)).find((r) => r.externalId === chat)!;
      expect(full.title, 'the fixture chat is not untitled, so it proves nothing').toBeNull();
      expect(full.sessionId, 'the full answer did not save the chat').toBeTruthy();

      // The quick answer holds it too.
      const quick = (await restore(true)).find((r) => r.externalId === chat);
      expect(quick, 'the quick list left out a saved untitled terminal chat').toBeTruthy();

      await page.goto(`/project?id=${project.id}&tab=chat`);
      await page.locator(`[data-testid="restore-row"][data-external-id="${chat}"]`).waitFor({ timeout: LISTED_MS });
      await page.screenshot({ path: join(SHOTS, 'untitled-terminal-chat-listed.png') });
    } finally {
      remove();
      await request.delete(`/api/projects/${project.id}`);
    }
  });
});
