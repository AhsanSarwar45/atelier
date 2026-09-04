import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { expect, test } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

/**
 * The shape of the checklist on an opened chat.
 *
 * A long epic used to arrive unfolded and as tall as it liked, so opening the
 * chat meant reading a wall of card titles before the conversation. This drives
 * a thirteen-row checklist on a real screen and photographs both states
 * (bw-i7pg.1).
 */

const CHAT = 'checklist-shape-fixture';
const EPIC = 'cl-epic';
const SHOT = process.env.CHECKLIST_SHOT_DIR || 'tests/results/checklist-shape';

test.setTimeout(120_000);

const TITLES = [
  'A chat started on a local model stays on the list: it is there on the next look and after the app restarts, instead of vanishing the instant it is made',
  'Chats from other local agent apps on this machine are offered in the list',
  'A local chat starts without being refused for a mode the agent never offered: Atelier only asks an ACP agent to change permission mode when that mode is one the agent advertises in availableModes',
  "A runtime that never reports residency still gets its model preferred: when an OpenAI-compatible endpoint returns a catalogue in which no entry carries a status at all, the model that process is serving is treated as the one it holds",
  'More than one local OpenAI-compatible runtime can be seen at once',
  'Opening a chat that was just started does not file it as asleep',
  'A local chat that never chose a model can be ended',
  'Reopening a local chat that has no model asks for a model instead of reporting a broken install',
  'The provider picker tells the truth about local agents and says why when it cannot start one',
  'Local model discovery is not defeated by a runtime that answers slowly or starts late',
  'A new local chat starts on a model instead of asking for one',
  'Choosing a model that is not the resident one says what it will cost before it happens',
  'A local runtime that is not reachable is said plainly, and the chat recovers when it comes back',
];

const STATUS = (i: number) => (i === 0 || i === 2 || i === 5 || i === 10 ? 'closed' : i === 12 ? 'in_progress' : 'open');

function fixtureProject(dir: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'workbench test'], { cwd: dir, stdio: 'pipe' });
  mkdirSync(join(dir, '.atelier'), { recursive: true });
  writeFileSync(
    join(dir, '.atelier', 'project.toml'),
    [
      'schema_version = 1',
      '',
      '[project]',
      `display_name = "${basename(dir)}"`,
      'use_beads = true',
      'summary = ""',
      '',
      '[git]',
      'completed_work_branch = "master"',
      '',
      '[beads]',
      'issue_id_prefix = "cl"',
      '',
    ].join('\n'),
  );
  return dir;
}

test('a long checklist opens folded and scrolls when it is opened', async ({ page, request }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  const run = join(process.cwd(), 'tests', '.workbench-run-checklist-shape');
  const projectPath = fixtureProject(join(run, 'project'));

  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    {
      ...base,
      seq: 1,
      type: 'session.started',
      brand: 'claude',
      externalId: 'fixture',
      model: 'claude-opus-5[1m]',
      cwd: projectPath,
      permissionMode: 'bypassPermissions',
      effort: 'high',
    },
    { ...base, seq: 2, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 3, type: 'text.delta', messageId: 'answer', text: 'The local model work is under way.' },
    { ...base, seq: 4, type: 'message.completed', messageId: 'answer' },
    { ...base, seq: 5, type: 'todo', items: [{ id: 'epic-row', text: EPIC, status: 'in_progress' }] },
    { ...base, seq: 6, type: 'session.state', state: 'idle', label: 'Ready' },
  ];
  const snapshot = foldAll(events);

  const beads = [
    {
      id: EPIC,
      title: 'Local models',
      status: 'in_progress',
      issue_type: 'epic',
      priority: 0,
      owner: '',
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      children: TITLES.map((_, i) => `${EPIC}.${i + 1}`),
    },
    ...TITLES.map((title, i) => ({
      id: `${EPIC}.${i + 1}`,
      title,
      status: STATUS(i),
      issue_type: 'task',
      priority: 0,
      owner: '',
      parent_id: EPIC,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    })),
  ];

  await page.addInitScript(({ chat, view }) => {
    class FixtureSocket {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = FixtureSocket.OPEN;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string) {
        if (new URL(url).searchParams.get('chat') === chat)
          setTimeout(
            () =>
              this.onmessage?.(
                new MessageEvent('message', {
                  data: JSON.stringify({ tag: 'chat.snapshot', scope: chat, data: JSON.stringify(view) }),
                }),
              ),
            0,
          );
      }
      close() {
        this.readyState = FixtureSocket.CLOSED;
      }
      send() {}
    }
    Object.defineProperty(window, 'WebSocket', { value: FixtureSocket, configurable: true });
  }, { chat: CHAT, view: snapshot });

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  // The board this checklist is a view of, answered without a real database:
  // what is being photographed is the panel's shape, not bd.
  await page.route(/\/api\/beads(\?.*)?$/, (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { beads } }) : route.continue(),
  );
  const row = {
    sessionId: CHAT,
    externalId: 'fixture',
    brand: 'claude',
    title: 'Local models',
    state: 'idle',
    lastActiveAt: new Date(0).toISOString(),
    cwdHint: projectPath,
    runningElsewhere: false,
    held: null,
    beads: [EPIC],
  };
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [row] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) =>
    route.fulfill({
      json: { ...row, origin: 'terminal', cwd: projectPath },
    }),
  );

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', {
      data: { name: 'Checklist shape fixture', path: projectPath, isTest: true },
    });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    await page.getByTestId('restore-row').filter({ hasText: 'Local models' }).getByTestId('row-name').click();
    await expect(page.getByText('The local model work is under way.')).toBeVisible();

    const panel = page.getByTestId('todo-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    mkdirSync(SHOT, { recursive: true });

    // As opened: the panel is one row, and the conversation is what is on screen.
    await expect(panel).toHaveAttribute('data-expanded', 'no');
    await page.screenshot({ path: join(SHOT, 'opened.png') });

    // Unfolded by hand: every row is reachable, inside a box with a ceiling.
    await page.getByRole('button', { name: /checklist/i }).click();
    await expect(panel).toHaveAttribute('data-expanded', 'yes');
    await expect(page.locator('[data-testid="todo-item"]')).toHaveCount(TITLES.length);
    const box = await page.locator('#active-checklist-items').evaluate((el) => ({
      client: el.clientHeight,
      scroll: el.scrollHeight,
    }));
    expect(box.scroll).toBeGreaterThan(box.client);
    expect(box.client).toBeLessThanOrEqual(Math.round(800 * 0.4) + 1);
    await page.screenshot({ path: join(SHOT, 'unfolded.png') });
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`).catch(() => {});
    rmSync(run, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
