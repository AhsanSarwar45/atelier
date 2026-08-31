import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import type { Brand, WbpEvent } from '../../src/workbench/protocol';
import { restartInstance } from './restart';

type Project = { id: string; path: string };

const RUN = process.env.WORKBENCH_E2E_RUN!;
const DATABASE = join(process.env.ATELIER_DATA_DIR!, 'workbench.db');
const BINARY = join(__dirname, '..', '..', 'server', 'target', 'debug', 'atelier');

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function execution(brand: Brand, operationId: string | null, parentOperationId: string | null = null) {
  return {
    conversationId: `${brand}-thread`,
    actorId: operationId === null ? `${brand}-root` : `${brand}-helper`,
    actorName: operationId === null ? brand : `${brand} reviewer`,
    parentActorId: operationId === null ? null : `${brand}-root`,
    operationId,
    parentOperationId,
  };
}

function providerEvent(brand: Brand, eventId: string) {
  return { provider: brand, threadId: `${brand}-thread`, eventId, delivery: 'live' as const };
}

function event(brand: Brand, sessionId: string, seq: number, body: object): WbpEvent {
  return {
    ...body,
    seq,
    sessionId,
    at: new Date(Date.UTC(2026, 7, 28, 8, 0, seq)).toISOString(),
    providerEvent: providerEvent(brand, `native-${seq}`),
  } as WbpEvent;
}

function providerTimeline(brand: Brand, sessionId: string): WbpEvent[] {
  const helper = `${brand}-helper`;
  const spawn = `${brand}-spawn`;
  const root = execution(brand, null);
  const child = execution(brand, spawn, spawn);
  const command = brand === 'claude' ? 'Agent' : 'spawn_agent';
  const events = [
    event(brand, sessionId, 1, {
      type: 'session.started', brand, externalId: `${brand}-thread`, model: `${brand}-model`,
      cwd: RUN, permissionMode: 'never', execution: root,
    }),
    event(brand, sessionId, 2, { type: 'session.state', state: 'dormant', label: 'Asleep', execution: root }),
    event(brand, sessionId, 3, { type: 'message.started', messageId: `${brand}-user`, role: 'user', execution: root }),
    event(brand, sessionId, 4, { type: 'text.delta', messageId: `${brand}-user`, text: `Start the ${brand} reviewer.`, execution: root }),
    event(brand, sessionId, 5, { type: 'message.completed', messageId: `${brand}-user`, execution: root }),
    event(brand, sessionId, 6, {
      type: 'tool.started', toolCallId: spawn, name: command,
      input: { prompt: `Inspect the ${brand} session` }, title: `Sent off ${brand} reviewer`,
      parentToolCallId: null, execution: { ...root, operationId: spawn },
    }),
    event(brand, sessionId, 7, {
      type: 'agent.started', agentId: helper, toolCallId: spawn, kind: 'helper',
      what: `Inspect the ${brand} session`, agentType: 'reviewer', model: `${brand}-model`, execution: child,
    }),
    event(brand, sessionId, 8, {
      type: 'message.started', messageId: `${brand}-child-answer`, role: 'assistant',
      parentToolCallId: spawn, execution: child,
    }),
    event(brand, sessionId, 9, {
      type: 'text.delta', messageId: `${brand}-child-answer`, text: `${brand.toUpperCase()} CHILD DONE`, execution: child,
    }),
    event(brand, sessionId, 10, { type: 'message.completed', messageId: `${brand}-child-answer`, execution: child }),
    event(brand, sessionId, 11, {
      type: 'agent.finished', agentId: helper, state: 'done', seconds: 4, tokens: 21, calls: 0,
      model: `${brand}-model`, result: `${brand.toUpperCase()} CHILD DONE`, execution: child,
    }),
    event(brand, sessionId, 12, {
      type: 'tool.completed', toolCallId: spawn, ok: true, output: `${brand.toUpperCase()} CHILD DONE`,
      title: `${brand} reviewer finished`, execution: { ...root, operationId: spawn },
    }),
  ];
  if (brand === 'codex') {
    events.push(
      event(brand, sessionId, 13, {
        type: 'tool.started', toolCallId: 'codex-wait', name: 'wait_agent', input: { ids: [helper] },
        title: 'Waited for codex reviewer', parentToolCallId: null,
        execution: { ...root, operationId: 'codex-wait' },
      }),
      event(brand, sessionId, 14, {
        type: 'tool.completed', toolCallId: 'codex-wait', ok: true, output: `${helper}: done`,
        title: 'Waited for codex reviewer to finish', execution: { ...root, operationId: 'codex-wait' },
      }),
    );
  }
  let next = events.length + 1;
  events.push(
    event(brand, sessionId, next++, {
      type: 'message.started', messageId: `${brand}-answer`, role: 'assistant', execution: root,
    }),
    event(brand, sessionId, next++, {
      type: 'text.delta', messageId: `${brand}-answer`, text: `${brand.toUpperCase()} PARENT DONE`, execution: root,
    }),
    event(brand, sessionId, next, {
      type: 'message.completed', messageId: `${brand}-answer`, execution: root,
    }),
  );
  return events;
}

function seedSession(project: Project, brand: Brand): string {
  const sessionId = `${brand}-canonical-session`;
  const now = '2026-08-28T08:00:00.000Z';
  const events = providerTimeline(brand, sessionId);
  const statements = [
    `INSERT INTO session
      (id, brand, external_id, project_id, project_path, cwd, model, permission_mode, title, state, origin, created_at, last_active_at)
      VALUES (${sql(sessionId)}, ${sql(brand)}, ${sql(`${brand}-thread`)}, ${sql(project.id)}, ${sql(project.path)},
        ${sql(project.path)}, ${sql(`${brand}-model`)}, 'never', ${sql(`${brand} native reconciliation`)},
        'dormant', 'app', ${sql(now)}, ${sql(now)});`,
    ...events.map((row) => `INSERT INTO event
      (session_id, seq, at, type, json, provider, provider_thread_id, provider_event_id)
      VALUES (${sql(sessionId)}, ${row.seq}, ${sql(row.at)}, ${sql(row.type)}, ${sql(JSON.stringify(row))},
        ${sql(brand)}, ${sql(`${brand}-thread`)}, ${sql(row.providerEvent!.eventId)});`),
  ];
  execFileSync('sqlite3', [DATABASE, `BEGIN IMMEDIATE;\n${statements.join('\n')}\nCOMMIT;`]);
  return sessionId;
}

async function createProject(request: APIRequestContext): Promise<Project> {
  const path = join(RUN, 'provider-reconciliation-project');
  mkdirSync(path, { recursive: true });
  const response = await request.post('/api/projects', {
    data: { name: 'provider reconciliation', path, isTest: true },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as Project;
}

async function restart(): Promise<void> {
  await restartInstance({
    binary: BINARY,
    serverPort: Number(process.env.BEADS_WEB_PORT),
    sidecarPort: Number(process.env.BEADS_WORKBENCH_PORT),
    env: process.env,
    healthUrl: `${process.env.BEADS_E2E_URL}/api/workbench/health`,
    logFile: join(RUN, 'server.log'),
  });
}

async function assertCanonical(page: Page, project: Project, brand: Brand, sessionId: string): Promise<void> {
  await page.goto(`/project?id=${project.id}&tab=chat&chat=${sessionId}`);
  await page.getByTestId('chat-tab').waitFor({ timeout: 60_000 });

  await expect(page.getByTestId('user-message').filter({ hasText: `Start the ${brand} reviewer.` })).toHaveCount(1);
  const parent = page.getByTestId('assistant-message').filter({ hasText: `${brand.toUpperCase()} PARENT DONE` });
  await expect(parent).toHaveCount(1);
  await expect(parent).toHaveAttribute('data-actor-id', `${brand}-root`);
  await expect(parent).toHaveAttribute('data-conversation-id', `${brand}-thread`);

  // The helper's native answer belongs to its child conversation, never to the
  // parent transcript as an ordinary root-agent message.
  await expect(page.getByTestId('assistant-message').filter({ hasText: `${brand.toUpperCase()} CHILD DONE` }))
    .toHaveCount(0);

  const command = brand === 'claude' ? 'Agent' : 'spawn_agent';
  const spawn = page.locator(`[data-testid="tool-row"][data-tool-name="${command}"]`);
  await expect(spawn).toHaveCount(1);
  await expect(spawn).toHaveAttribute('data-ran-kind', 'agent');
  await expect(spawn.getByTestId('tool-mark')).toBeVisible();
  await expect(spawn).toContainText(`${brand} reviewer finished`);

  const helper = page.locator(`[data-testid="sent-away-row"][data-agent="${brand}-helper"]`);
  await expect(helper).toHaveCount(1);
  await expect(helper).toHaveAttribute('data-state', 'done');
  await expect(helper.getByTestId('sent-away-what')).toHaveText(`Inspect the ${brand} session`);
  if (!(await helper.isVisible())) await page.getByTestId('toggle-stopped-agents').click();
  await helper.click();
  const child = page.getByTestId('agent-view').getByTestId('assistant-message')
    .filter({ hasText: `${brand.toUpperCase()} CHILD DONE` });
  await expect(child).toHaveCount(1);
  await expect(child).toHaveAttribute('data-actor-id', `${brand}-helper`);
  await expect(child).toHaveAttribute('data-parent-agent-id', `${brand}-root`);
  await page.getByTestId('agent-view-close').click();

  if (brand === 'codex') {
    const waited = page.locator('[data-testid="tool-row"][data-tool-name="wait_agent"]');
    await expect(waited).toHaveCount(1);
    await expect(waited).toContainText('Waited for codex reviewer to finish');
  }
}

test('Claude and Codex keep one recursive native timeline through repeated app restarts', async ({ page, request }) => {
  test.setTimeout(180_000);
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  const project = await createProject(request);
  try {
    const sessions = {
      claude: seedSession(project, 'claude'),
      codex: seedSession(project, 'codex'),
    };

    for (let generation = 0; generation < 2; generation += 1) {
      await restart();
      await assertCanonical(page, project, 'claude', sessions.claude);
      await assertCanonical(page, project, 'codex', sessions.codex);
    }
  } finally {
    await request.delete(`/api/projects/${project.id}`).catch(() => {});
  }
});
