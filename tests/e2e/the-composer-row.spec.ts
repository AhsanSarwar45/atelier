import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

/**
 * Where the composer row changes its mind about the width it has (bw-e3dw.11).
 *
 * bw-e3dw.9 gave the app one answer to "is this a phone" — `md`, 768px, in
 * `src/lib/screen-width.ts` — and every sheet in the app switches there. The
 * composer row did not move with it: its pickers and the chips above them are
 * written `sm:`, so between 640 and 767 the rails are sheets and the composer
 * is a desktop's.
 *
 * That is a real disagreement, but the two are not the same question. A sheet
 * is about whether there is room for a column BESIDE the reading. A row of
 * controls is about whether its own contents fit on one line, which depends on
 * how many controls this particular chat has, not on the shape of the screen.
 * So this case does not assume; it asks the row, at the five widths that
 * matter, with a chat that has every steering control a Claude session offers.
 *
 * bw-e3dw.12 then made the row ask that question of ITSELF rather than of the
 * window, because between 768 and about 1250 the two open rails are what leave
 * it short and a media query cannot see them. The two widths this case used to
 * walk without judging are judged from there on.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/the-composer-row.spec.ts
 */

const STAGE = process.env.COMPOSER_ROW_STAGE ?? 'now';
const SHOTS = `tests/results/composer-row/${STAGE}`;
const WAIT = 60_000;
const CHAT = 'composer-row-chat';

/**
 * A phone, the band the epic argued about, and two desktops — and the two
 * widths in between where the rails are what squeeze the row.
 *
 * Above 768 the two rails stop being sheets and become columns of 288 each, so
 * a 900px window leaves the composer 258px and an 1100px one leaves it 458px,
 * while the desktop row of pickers is 656px wide. It did not fit in either at
 * any breakpoint and would have needed roughly a 1250px window before it did:
 * the row was squeezed by what is BESIDE it, which no media query can see,
 * because the number a `min-width` reads is the window's.
 *
 * bw-e3dw.11 measured those two widths and left them unjudged, because the
 * fault was not its card's. bw-e3dw.12 is that card, and every width here is
 * judged now. The row asks its own width through a container query
 * (`composer-wide:`, tailwind.config.ts), so 900 and 1100 are answered by the
 * same rule that answers 390 — and 1440, where the row does have the room it
 * asks for, still puts the pickers on the row.
 */
const WIDTHS = [
  { name: '390-a-phone', width: 390, height: 844, judged: true },
  { name: '700-the-band', width: 700, height: 900, judged: true },
  { name: '900-both-rails-open', width: 900, height: 900, judged: true },
  { name: '1100-both-rails-open', width: 1100, height: 900, judged: true },
  { name: '1440-a-desktop', width: 1440, height: 900, judged: true },
];

const measured: string[] = [];
function note(what: string): void {
  measured.push(what);
}

function git(at: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd: at,
    stdio: 'pipe',
  });
}

function seed(where: string): void {
  rmSync(where, { recursive: true, force: true });
  mkdirSync(where, { recursive: true });
  writeFileSync(join(where, 'README.md'), '# The composer row\n');
  git(where, 'init', '-q', '-b', 'main', '.');
  git(where, 'config', 'user.name', 'Composer Row');
  git(where, 'config', 'user.email', 'composer-row@atelier.test');
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
 * What the two rows are doing at this width.
 *
 * A row that has run out of room says so in one number: it holds more than it
 * can show. Nothing is pushed off the end where it could be forgotten — the
 * row is a flex line with `ml-auto` holding the send button against the right
 * edge — so what runs out of room is printed over its neighbour instead, and
 * the picture beside these numbers is where that is read.
 */
async function rows(page: Page) {
  return page.evaluate(() => {
    const read = (el: HTMLElement | null) =>
      el
        ? {
            width: Math.round(el.getBoundingClientRect().width),
            height: Math.round(el.getBoundingClientRect().height),
            scroll: el.scrollWidth,
          }
        : null;
    const shown = (id: string) => {
      const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
      return el !== null && getComputedStyle(el).display !== 'none';
    };
    const tools = (document.querySelector('[data-testid="attach-picture"]')?.parentElement ?? null) as HTMLElement | null;
    return {
      tools: read(tools),
      status: read(document.querySelector('[data-testid="chat-status-line"]')),
      desktopSettings: shown('desktop-composer-settings'),
      phoneSettings: shown('mobile-composer-settings'),
      window: window.innerWidth,
    };
  });
}

test('the composer row at 390, 700 and 900, with every steering control a chat can have', async ({ page, request }) => {
  test.setTimeout(600_000);
  const fixture = join(__dirname, '..', '.workbench-run-composer-row');
  seed(fixture);

  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture', model: 'claude-opus-5', cwd: fixture, permissionMode: 'on-request' },
    // The busiest honest row: every steering control a Claude session offers,
    // because a row measured with two buttons in it proves nothing about a row.
    {
      ...base,
      seq: 2,
      type: 'session.menu',
      commands: [],
      skills: [],
      models: [
        { value: 'claude-opus-5', displayName: 'Opus 5', group: 'alias' },
        { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', group: 'alias' },
        { value: 'claude-haiku-4-5', displayName: 'Haiku 4.5', group: 'alias' },
      ],
      permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
      collaborationModes: [
        { value: 'default', displayName: 'Default' },
        { value: 'plan', displayName: 'Plan' },
      ],
      efforts: [
        { value: 'low', displayName: 'Low' },
        { value: 'medium', displayName: 'Medium' },
        { value: 'high', displayName: 'High' },
      ],
      agentDefinitions: [
        { name: 'scout', description: 'Reads the code and reports back', source: 'project' },
        { name: 'verify', description: 'Runs the suite', source: 'user' },
      ],
      configOptions: [
        { id: 'thinking', name: 'Extended thinking', type: 'boolean', currentValue: true },
      ],
      agentControls: ['stop', 'park', 'say'],
    },
    { ...base, seq: 3, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 4, type: 'text.delta', messageId: 'answer', text: 'A short answer, read at three widths.' },
    { ...base, seq: 5, type: 'message.completed', messageId: 'answer' },
    { ...base, seq: 6, type: 'session.state', state: 'idle', label: 'Ready' },
  ];

  await page.addInitScript(({ chat, view }) => {
    class FixtureSocket {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = FixtureSocket.OPEN;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string) {
        if (new URL(url).searchParams.get('chat') !== chat) return;
        const push = (data: unknown) =>
          this.onmessage?.(
            new MessageEvent('message', {
              data: JSON.stringify({ tag: 'chat.snapshot', scope: chat, data: JSON.stringify(data) }),
            }),
          );
        setTimeout(() => push(view), 0);
      }
      close() {
        this.readyState = FixtureSocket.CLOSED;
      }
      send() {}
    }
    Object.defineProperty(window, 'WebSocket', { value: FixtureSocket, configurable: true });
  }, { chat: CHAT, view: foldAll(events) });

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
        title: 'A chat with every control it can have',
        cwd: fixture,
        beads: [],
      },
    }),
  );

  const project = await fixtureProject(request, 'composer-row', fixture);
  mkdirSync(SHOTS, { recursive: true });
  const wrong: string[] = [];

  try {
    for (const at of WIDTHS) {
      await page.setViewportSize({ width: at.width, height: at.height });
      await page.goto(`/project?id=${project.id}&tab=chat&chat=${CHAT}`);
      await expect(page.getByTestId('transcript')).toBeVisible({ timeout: WAIT });
      await page.waitForTimeout(2000);
      const seen = await rows(page);
      note(
        `at ${at.width}px: the tool row holds ${seen.tools?.scroll ?? -1}px in ${seen.tools?.width ?? -1}px; ` +
          `the status line holds ${seen.status?.scroll ?? -1}px in ${seen.status?.width ?? -1}px, ` +
          `${seen.status?.height ?? -1}px tall; the pickers are ` +
          `${seen.desktopSettings ? 'on the row' : 'behind the settings button'}` +
          `${seen.phoneSettings ? '' : ' (no settings button drawn)'}`,
      );
      await page.screenshot({ path: `${SHOTS}/${at.name}.png`, animations: 'disabled' });

      // Whichever side of the breakpoint this width falls, exactly one way in
      // to the chat's settings is drawn. Two would be the same control twice,
      // and none would be a setting with no way to reach it.
      if (seen.desktopSettings === seen.phoneSettings) {
        wrong.push(
          `at ${at.width}px the chat's settings are reachable ${seen.desktopSettings ? 'twice' : 'not at all'}`,
        );
      }
      if (!at.judged) continue;
      // The row fits the width it has. That is the question the breakpoint is
      // answering, so it is the question asked. Every width is walked before any is judged, so one bad width
      // does not hide the rest.
      if (seen.tools!.scroll > seen.tools!.width + 1) {
        wrong.push(`at ${at.width}px the composer's tool row holds ${seen.tools!.scroll}px in ${seen.tools!.width}px`);
      }
      if (seen.status!.scroll > seen.status!.width + 1) {
        wrong.push(`at ${at.width}px the status line holds ${seen.status!.scroll}px in ${seen.status!.width}px`);
      }
    }
    expect(wrong, 'the composer row does not fit the width it is given').toEqual([]);
  } finally {
    writeFileSync(`${SHOTS}/measurements.txt`, measured.map((m) => `- ${m}`).join('\n') + '\n');
    // eslint-disable-next-line no-console
    console.log(`\n${measured.map((m) => `- ${m}`).join('\n')}\n`);
    await request.delete(`/api/projects/${project.id}`).catch(() => {});
  }
});
