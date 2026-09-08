import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * What a Codex chat's tool rows say, drawn by the real app from a real turn.
 *
 * Claude stamps its tool's own name on every ACP call, so the sentence rules
 * had a name to dispatch on. Codex sends a human title instead -- the whole
 * command, or "Editing files" -- and the same work drew a `key: value` dump
 * under the word "asked", with no verb, no mark and no colour. The naming is
 * done once at the ACP seam (`normalize.rs`, `call_named_by_acp`); this is the
 * chat that proves it, because nothing short of a live turn sends the shapes
 * the seam has to read (bw-rg6p).
 */
type Project = { id: string; path: string };

const ROOT = join(__dirname, '..', '.workbench-run-codex-rows');
const SHOTS = 'tests/results';
const TURN_MS = 600_000;
const SETTLE_MS = 180_000;

const PROMPT =
  'Do exactly these two things and nothing else. First run this one shell command: grep -n needle notes.txt . ' +
  'Second, use your file-reading tool to read notes.txt. Do not edit anything, do not search the web, ' +
  'do not spawn any agent. Then reply exactly CODEX ROWS DONE.';

async function createProject(request: APIRequestContext): Promise<Project> {
  const path = join(ROOT, 'work');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'notes.txt'), 'one\nthe needle is here\nthree\n');
  const response = await request.post('/api/projects', { data: { name: 'codex-rows', path, isTest: true } });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as Project;
}

test.describe('a Codex call reads as what it did', () => {
  test.describe.configure({ mode: 'serial', timeout: TURN_MS });

  test.skip(
    process.env.BEADS_E2E_LIVE_PROVIDERS !== '1',
    'needs a live provider: only a real Codex turn sends a call with no tool name on it',
  );

  test.beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
    mkdirSync(SHOTS, { recursive: true });
  });

  test('a shell call and a read say what they did, with a mark and a colour', async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });

    const project = await createProject(request);
    const started = await request.post('/api/workbench/command', {
      data: {
        type: 'session.start',
        projectId: project.id,
        projectPath: project.path,
        brand: 'codex',
        permissionMode: 'never',
      },
    });
    expect(started.ok(), await started.text()).toBe(true);
    const sessionId = ((await started.json()) as { id: string }).id;

    await page.goto(`/project?id=${project.id}&tab=chat&chat=${sessionId}`);
    await page.getByTestId('chat-tab').waitFor({ timeout: 120_000 });
    const sent = await request.post('/api/workbench/command', {
      data: { type: 'prompt.send', sessionId, text: PROMPT },
    });
    expect(sent.ok(), await sent.text()).toBe(true);

    await expect(page.getByTestId('assistant-message').last()).toContainText('CODEX ROWS DONE', {
      timeout: SETTLE_MS,
    });

    const rows = page.getByTestId('tool-row');
    await expect(rows.first()).toBeVisible();
    const shot = page.getByTestId('chat-tab');
    await shot.screenshot({ path: join(SHOTS, 'codex-rows-after.png') });

    // Every row it drew, and what each one says. Printed rather than only
    // asserted: a run of this case is the evidence, and the words are the
    // point of it.
    const drawn = await rows.evaluateAll((nodes) =>
      nodes.map((node) => ({
        kind: node.getAttribute('data-ran-kind'),
        says: (node.textContent ?? '').trim().slice(0, 90),
      })),
    );
    console.log(JSON.stringify(drawn, null, 2));

    // The shell call: a sentence about the command, not the command as a form,
    // and a mark saying something ran.
    const ran = drawn.find((row) => row.kind === 'run' || row.kind === 'search');
    expect(ran, `no row for the command; drew ${JSON.stringify(drawn)}`).toBeDefined();
    // The read: named, and the file named with it.
    const read = drawn.find((row) => row.kind === 'read');
    expect(read, `no row for the read; drew ${JSON.stringify(drawn)}`).toBeDefined();
    expect(read!.says).toContain('notes.txt');
    // Nothing left colourless: a row with no kind is a row nothing could say
    // anything about, which is the state this case exists to end.
    expect(drawn.filter((row) => row.kind === null)).toEqual([]);
  });
});
