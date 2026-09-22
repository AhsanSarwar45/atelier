import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';
import type { SessionState, WbpEvent } from '../../src/workbench/protocol';

/**
 * What the writing box offers when the only thing still going is a task the
 * agent sent away (bw-ekpt).
 *
 * One word, `busy`, used to answer two questions: whether Stop should be on
 * offer, and whether a message typed now would land in the middle of a turn.
 * They differ in exactly one state. `waiting_for_agents` is reached only once
 * the reply is over and a task it started is not (status.rs, `resolve`), so
 * there is no turn to land in the middle of — and the box queued the message
 * anyway, behind work nobody was waiting on. On a long background task that is
 * the difference between being answered now and being answered in ten minutes.
 *
 * So the two questions are asked separately, and this case reads both rows off
 * the screen at the two states that tell them apart:
 *
 *   - mid-reply, the row is unchanged: Stop, Queue, Send now.
 *   - reply over, background still going: Stop and Send, because the message
 *     has nothing to wait for and the task can still be stopped.
 *
 * The second row is the one that changed. The first is here so the picture
 * shows the change is a narrowing and not a removal: queueing is exactly as it
 * was everywhere a reply is actually being written.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-message-past-a-background-task.spec.ts
 */

/** `before` reads the same screen on the old code, for the picture beside it. */
const STAGE = process.env.QUEUE_STAGE ?? 'now';
const SHOTS = `tests/results/a-message-past-a-background-task/${STAGE}`;
const WAIT = 60_000;
const CHAT = 'past-a-background-task';
const TYPED = 'and while that runs, what did the first one say?';

/**
 * The two states that tell the two questions apart, and what each row should
 * hold once something is written in the box.
 *
 * `label` is what the server sends: a state whose word the screen supplies
 * itself sends none, which is what `waiting_for_agents` does (status.rs).
 */
const STATES: {
  name: string;
  state: SessionState;
  label: string | null;
  offers: string[];
  withholds: string[];
  /** What Enter should ask the server for, once something is written. */
  enter: string;
}[] = [
  {
    name: 'mid-reply',
    state: 'thinking',
    label: 'Thinking',
    offers: ['stop-button', 'queue-button', 'send-now-button'],
    withholds: ['send-button'],
    enter: 'prompt.hold',
  },
  {
    name: 'reply-over-task-still-running',
    state: 'waiting_for_agents',
    label: null,
    offers: ['stop-button', 'send-button'],
    withholds: ['queue-button', 'send-now-button'],
    enter: 'prompt.send',
  },
];

function git(at: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd: at,
    stdio: 'pipe',
  });
}

function seed(where: string): void {
  rmSync(where, { recursive: true, force: true });
  mkdirSync(where, { recursive: true });
  writeFileSync(join(where, 'README.md'), '# A message past a background task\n');
  git(where, 'init', '-q', '-b', 'main', '.');
  git(where, 'config', 'user.name', 'Past A Background Task');
  git(where, 'config', 'user.email', 'past-a-background-task@atelier.test');
  git(where, 'config', 'commit.gpgsign', 'false');
  git(where, 'add', '-A');
  git(where, 'commit', '-qm', 'seed');
}

async function fixtureProject(request: APIRequestContext, name: string, path: string) {
  const made = await request.post('/api/projects', { data: { name, path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

async function seeTestProjects(page: Page): Promise<void> {
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
}

/**
 * A chat that has finished saying something, left in the state named.
 *
 * The reply is complete in every case: the state is what differs, which is the
 * whole of what this case is about.
 */
function aChatIn(state: SessionState, label: string | null, cwd: string): WbpEvent[] {
  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  return [
    { ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture', model: 'claude-opus-5', cwd, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 3, type: 'text.delta', messageId: 'answer', text: 'Started the long one in the background.' },
    { ...base, seq: 4, type: 'message.completed', messageId: 'answer' },
    { ...base, seq: 5, type: 'session.state', state, label },
  ] as WbpEvent[];
}

test('a message typed while only a sent-away task is running is sent, not queued', async ({ page, request }) => {
  test.setTimeout(600_000);
  const fixture = join(__dirname, '..', '.workbench-run-past-a-background-task');
  seed(fixture);

  await seeTestProjects(page);
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) =>
    route.fulfill({
      json: {
        sessionId: CHAT,
        origin: 'terminal',
        brand: 'claude',
        externalId: 'fixture',
        runningElsewhere: false,
        held: null,
        title: 'A chat with a task of its own still running',
        cwd: fixture,
        beads: [],
      },
    }),
  );

  // What the screen asked the server for. The chat here is a fixture, so a
  // real command would be refused and the writing box would rightly keep what
  // it holds — which says nothing about what Enter meant. What was asked for
  // does.
  const asked: string[] = [];
  await page.route(/\/api\/workbench\/command$/, async (route) => {
    const body = route.request().postDataJSON() as { type?: string };
    if (typeof body?.type === 'string') asked.push(body.type);
    await route.fulfill({ json: { model: null, effort: null } });
  });

  const project = await fixtureProject(request, 'past-a-background-task', fixture);
  mkdirSync(SHOTS, { recursive: true });
  const wrong: string[] = [];
  const read: string[] = [];

  try {
    await page.setViewportSize({ width: 1100, height: 800 });

    for (const at of STATES) {
      // The socket is replaced per state, so each row is read on a chat that
      // has only ever been in the state it is being judged for.
      await page.addInitScript(({ chat, view }) => {
        class FixtureSocket {
          static OPEN = 1;
          static CLOSED = 3;
          readyState = FixtureSocket.OPEN;
          onmessage: ((event: MessageEvent) => void) | null = null;
          constructor(url: string) {
            if (new URL(url).searchParams.get('chat') !== chat) return;
            setTimeout(() => this.onmessage?.(new MessageEvent('message', {
              data: JSON.stringify({ tag: 'chat.snapshot', scope: chat, data: JSON.stringify(view) }),
            })), 0);
          }
          close() { this.readyState = FixtureSocket.CLOSED; }
          send() {}
        }
        Object.defineProperty(window, 'WebSocket', { value: FixtureSocket, configurable: true });
      }, { chat: CHAT, view: foldAll(aChatIn(at.state, at.label, fixture)) });

      await page.goto(`/project?id=${project.id}&tab=chat&chat=${CHAT}`);
      await expect(page.getByTestId('transcript')).toBeVisible({ timeout: WAIT });
      await expect(page.getByText('Started the long one in the background.')).toBeVisible({ timeout: WAIT });

      // Typed the way a reader types it: the buttons appear on there being
      // something to send, which a value set from outside does not report.
      const writing = page.getByTestId('composer-frame').locator('.cm-content');
      await writing.click();
      // An unsent line is kept for the reader between visits, so the second
      // state would otherwise be typed into the first one's leftovers.
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      await expect(page.getByTestId('composer')).toHaveValue('');
      await page.keyboard.type(TYPED);
      await expect(page.getByTestId('composer')).toHaveValue(TYPED);
      await page.waitForTimeout(500);

      // The picture first, so the row is on disk however the reading goes.
      await page.getByTestId('composer-frame').screenshot({
        path: `${SHOTS}/${at.name}.png`,
        animations: 'disabled',
      });

      const drawn = await page.evaluate(
        (ids) => ids.filter((id) => document.querySelector(`[data-testid="${id}"]`) !== null),
        [...at.offers, ...at.withholds],
      );
      read.push(`${at.name} (${at.state}): the row holds ${drawn.join(', ') || 'nothing'}`);

      for (const id of at.offers) {
        if (!drawn.includes(id)) wrong.push(`${at.name}: the row does not offer ${id}`);
      }
      for (const id of at.withholds) {
        if (drawn.includes(id)) wrong.push(`${at.name}: the row still offers ${id}`);
      }

      // Enter says the same thing the row does. Mid-reply it holds the
      // message; with only a task of its own left it sends it.
      asked.length = 0;
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1000);
      const meant = asked.filter((type) => type === 'prompt.send' || type === 'prompt.hold');
      read.push(`${at.name} (${at.state}): Enter asked for ${meant.join(', ') || 'nothing'}`);
      if (meant.join(',') !== at.enter) {
        wrong.push(`${at.name}: Enter asked for ${meant.join(', ') || 'nothing'}, not ${at.enter}`);
      }
    }

    expect(wrong, 'the row and the Enter key agree about what is worth waiting for').toEqual([]);
  } finally {
    writeFileSync(`${SHOTS}/what-was-read.txt`, read.map((line) => `- ${line}`).join('\n') + '\n');
    // eslint-disable-next-line no-console
    console.log(`\n${read.map((line) => `- ${line}`).join('\n')}\n`);
    await request.delete(`/api/projects/${project.id}`).catch(() => {});
  }
});
