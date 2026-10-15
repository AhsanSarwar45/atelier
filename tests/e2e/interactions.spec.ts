import { expect, test } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

const CHAT = 'interaction-cards-fixture';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
// Both cases add a fixture project for this same folder, so they cannot overlap.
test.describe.configure({ mode: 'serial' });

test('questions and proposed plans share one complete interaction language', async ({ page, request }) => {
  test.setTimeout(60_000);
  // This card is answered from phones as often as desktops. Keep the fixture
  // narrow enough to exercise the coarse, single-column presentation that
  // exposed the custom checkbox growing into a large empty square.
  const bare: Omit<WbpEvent, 'seq' | 'sessionId' | 'at'>[] = [
    { type: 'session.started', brand: 'codex', externalId: 'fixture-thread', model: 'gpt-5', cwd: process.cwd(), permissionMode: 'on-request', effort: 'high', collaborationMode: 'plan' },
    { type: 'question.requested', requestId: 'questions', blocking: true, questions: [
      {
        id: 'database', header: 'Database', prompt: 'Which database should the service use?', selection: 'single',
        options: [
          { id: 'postgres', label: 'Postgres', description: 'Durable relational storage for a deployed service.' },
          { id: 'sqlite', label: 'SQLite', description: 'A small embedded database with no separate server.' },
        ],
        allowCustom: true, secret: false,
      },
      {
        id: 'checks', header: 'Verification', prompt: 'Choose every check that should run before release.', selection: 'multiple',
        options: [
          { id: 'unit', label: 'Unit tests', description: 'Fast checks for isolated behavior.' },
          { id: 'browser', label: 'Browser tests', description: 'Exercise the complete interaction in a real browser.' },
        ],
        allowCustom: true, secret: false,
      },
    ] },
    { type: 'plan.proposed', proposalId: 'plan', markdown: '# Release safely\n\n1. Add the shared interaction contract.\n2. Verify both provider adapters.\n3. Run browser proof.', actions: [
      { id: 'implement', kind: 'implement', label: 'Implement plan', description: 'Leave Plan mode and begin implementation.' },
      { id: 'request_changes', kind: 'request_changes', label: 'Request changes', description: 'Keep planning and explain what should change.', acceptsFeedback: true },
    ] },
    { type: 'session.state', state: 'waiting_permission', label: 'Waiting for your answer' },
  ];
  const events = bare.map((event, index) => ({ ...event, seq: index + 1, sessionId: CHAT, at: new Date(0).toISOString() })) as WbpEvent[];
  const snapshot = foldAll(events);

  await page.addInitScript(({ chat, view }) => {
    class FixtureSocket {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = FixtureSocket.OPEN;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string) {
        if (new URL(url).searchParams.get('chat') === chat) setTimeout(() => this.onmessage?.(new MessageEvent('message', {
          data: JSON.stringify({ tag: 'chat.snapshot', scope: chat, data: JSON.stringify(view) }),
        })), 0);
      }
      close() { this.readyState = FixtureSocket.CLOSED; }
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
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{
    sessionId: CHAT, externalId: 'fixture-thread', brand: 'codex', projectId: 'fixture', title: 'Interaction cards', name: 'Interaction cards',
    state: 'waiting_permission', lastActiveAt: new Date(0).toISOString(), cwdHint: process.cwd(), runningElsewhere: false, held: null, beads: [],
  }] }));
  await page.route(/\/api\/workbench\/command$/, (route) => route.fulfill({ json: {} }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: {
    sessionId: CHAT, origin: 'terminal', brand: 'codex', externalId: 'fixture-thread', runningElsewhere: false,
    held: null, title: 'Interaction cards', name: 'Interaction cards', cwd: process.cwd(), folder: 'bw-bxq7', branch: 'bw-bxq7', beads: [],
  } }));

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'Interaction card fixture', path: process.cwd(), isTest: true } });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    // The phone drawer is translated between frames while it opens; this test
    // owns the fixture row and is proving the cards after navigation, not the
    // drawer animation.
    await page.getByTestId('restore-row').filter({ hasText: 'Interaction cards' }).getByTestId('row-name')
      .evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.getByTestId('question-card')).toBeVisible();
    await expect(page.getByTestId('plan-card')).toBeVisible();

    await page.getByText('Postgres', { exact: true }).click();
    await page.getByText('Unit tests', { exact: true }).click();
    await page.getByText('Browser tests', { exact: true }).click();
    await page.getByRole('group', { name: 'Verification' }).getByRole('button', { name: 'Add note' }).click();
    await page.getByLabel('Note for Verification').fill('Run these on every pull request.');
    await page.getByTestId('plan-card').getByRole('radio', { name: /^Request changes/ }).click();
    await page.getByLabel('Requested plan changes').fill('Include a rollback step before implementation.');

    await page.getByTestId('question-card').screenshot({ path: 'tests/results/question-card-after.png' });
    await page.getByTestId('plan-card').screenshot({ path: 'tests/results/plan-card-after.png' });
    await page.screenshot({ path: process.env.INTERACTIONS_SCREENSHOT || 'tests/results/interactions-after.png', fullPage: true });
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`).catch(() => undefined);
  }
});

test('an answered question and a plan sent back keep the note and the changes that were sent', async ({ page, request }) => {
  test.setTimeout(60_000);
  const chat = 'interaction-cards-sent-fixture';
  const bare: Omit<WbpEvent, 'seq' | 'sessionId' | 'at'>[] = [
    { type: 'session.started', brand: 'claude', externalId: 'fixture-sent', model: 'opus', cwd: process.cwd(), permissionMode: 'plan', effort: 'high' },
    { type: 'question.requested', requestId: 'questions', blocking: true, questions: [
      {
        id: 'database', header: 'Database', prompt: 'Which database should the service use?', selection: 'single',
        options: [
          { id: 'postgres', label: 'Postgres', description: 'Durable relational storage for a deployed service.' },
          { id: 'sqlite', label: 'SQLite', description: 'A small embedded database with no separate server.' },
        ],
        allowCustom: true, secret: false,
      },
    ] },
    { type: 'question.resolved', requestId: 'questions', answers: [
      { questionId: 'database', optionIds: ['postgres'], note: 'Use the managed instance, not a local one.' },
    ] },
    { type: 'plan.proposed', proposalId: 'plan', markdown: '# Release safely\n\n1. Add the shared interaction contract.\n2. Run browser proof.', actions: [
      { id: 'approve', kind: 'approve', label: 'Approve plan' },
      { id: 'request_changes', kind: 'request_changes', label: 'Request changes', acceptsFeedback: true },
    ] },
    { type: 'plan.resolved', proposalId: 'plan', status: 'changes_requested', actionId: 'request_changes',
      feedback: 'Include a rollback step before implementation.' },
    { type: 'session.state', state: 'running', label: 'Working' },
  ];
  const events = bare.map((event, index) => ({ ...event, seq: index + 1, sessionId: chat, at: new Date(0).toISOString() })) as WbpEvent[];
  const snapshot = foldAll(events);

  await page.addInitScript(({ chat, view }) => {
    class FixtureSocket {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = FixtureSocket.OPEN;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string) {
        if (new URL(url).searchParams.get('chat') === chat) setTimeout(() => this.onmessage?.(new MessageEvent('message', {
          data: JSON.stringify({ tag: 'chat.snapshot', scope: chat, data: JSON.stringify(view) }),
        })), 0);
      }
      close() { this.readyState = FixtureSocket.CLOSED; }
      send() {}
    }
    Object.defineProperty(window, 'WebSocket', { value: FixtureSocket, configurable: true });
  }, { chat, view: snapshot });

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{
    sessionId: chat, externalId: 'fixture-sent', brand: 'claude', projectId: 'fixture', title: 'Sent answers', name: 'Sent answers',
    state: 'running', lastActiveAt: new Date(0).toISOString(), cwdHint: process.cwd(), runningElsewhere: false, held: null, beads: [],
  }] }));
  await page.route(new RegExp(`/api/workbench/session/${chat}$`), (route) => route.fulfill({ json: {
    sessionId: chat, origin: 'terminal', brand: 'claude', externalId: 'fixture-sent', runningElsewhere: false,
    held: null, title: 'Sent answers', name: 'Sent answers', cwd: process.cwd(), folder: 'bw-di436', branch: 'bw-di436', beads: [],
  } }));

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'Sent answers fixture', path: process.cwd(), isTest: true } });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    await page.getByTestId('restore-row').filter({ hasText: 'Sent answers' }).getByTestId('row-name')
      .evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.getByTestId('question-card')).toHaveAttribute('data-question-state', 'resolved');
    await expect(page.getByTestId('plan-card')).toHaveAttribute('data-plan-state', 'changes_requested');
    await page.getByTestId('question-card').screenshot({ path: process.env.SENT_QUESTION_SCREENSHOT || 'tests/results/question-card-sent.png' });
    await page.getByTestId('plan-card').screenshot({ path: process.env.SENT_PLAN_SCREENSHOT || 'tests/results/plan-card-sent.png' });

    await expect(page.getByTestId('question-card')).toContainText('Use the managed instance, not a local one.');
    await expect(page.getByTestId('plan-feedback')).toContainText('Include a rollback step before implementation.');
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`).catch(() => undefined);
  }
});
