import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configDir } from './fixture-record';

/**
 * The reader chooses which kinds of message a conversation draws.
 *
 * A busy chat is mostly the agent's own working — files read, commands run,
 * quiet notes about itself — and what it actually SAID is a handful of rows
 * buried in it. This drives the tree of switches on a real conversation: what
 * it hides, what it leaves standing, what it says the cost of each switch is,
 * and that a filtered chat still says so after a reload (bw-qdim.7).
 *
 * Run: BEADS_E2E_URL=http://127.0.0.1:3021 BEADS_E2E_BACKEND=http://127.0.0.1:3008 \
 *      npx playwright test tests/e2e/chat-filter.spec.ts
 */

const OPEN_MS = 60_000;

function backend(): string {
  return process.env.BEADS_E2E_BACKEND ?? '';
}

interface Project {
  id: string;
  path: string;
}

interface PastChat {
  sessionId: string | null;
  externalId: string | null;
  origin: string;
  title: string | null;
}

function pickProject(projects: Project[]): Project {
  expect(projects.length, 'the instance lists no projects').toBeGreaterThan(0);
  return process.env.BEADS_E2E_PROJECT
    ? projects.find((p) => p.id === process.env.BEADS_E2E_PROJECT)!
    : projects[0]!;
}

/**
 * A past conversation of his that both ran commands and said something back.
 *
 * Read rather than made: a chat with a real spread of kinds in it is what this
 * control exists for, and starting an agent to manufacture one costs a turn of
 * a live model per case. Asked of the screen rather than of the kit's record —
 * what the filter has to hide is what the screen DREW.
 */
async function aBusyChat(request: APIRequestContext, page: Page): Promise<{ project: Project; id: string }> {
  const api = backend();
  const projects = (await (await request.get(`${api}/api/projects`)).json()) as Project[];
  const project = pickProject(projects);
  const q = new URLSearchParams({ project: project.id, path: project.path });
  const rows = (await (await request.get(`${api}/api/workbench/restore?${q}`)).json()) as PastChat[];
  const candidates = rows.filter((r) => r.externalId).slice(0, 8);

  const tried: string[] = [];
  // A conversation that sent work off to a subagent draws that subagent's own
  // commands indented under the row that started it, and those rows are the
  // ones a check counting only the top of the conversation misses. So they are
  // what we go looking for, and any busy chat is only the fallback (bw-qdim.12).
  let fallback: { project: Project; id: string } | null = null;
  for (const past of candidates) {
    // Opened, which reads it and starts nothing (docs/designs/app-shell.md §1.9).
    const opened = (await (
      await request.post(`${api}/api/workbench/command`, {
        data: {
          type: 'session.open',
          sessionId: past.sessionId ?? undefined,
          externalId: past.externalId,
          brand: 'claude',
          projectId: project.id,
          projectPath: project.path,
        },
      })
    ).json()) as { id: string };

    await page.goto(`/project?id=${project.id}&tab=chat&chat=${opened.id}`);
    await page.getByTestId('chat-tab').waitFor({ timeout: OPEN_MS });

    const drew = await page
      .getByTestId('tool-row')
      .first()
      .waitFor({ timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    const spoke = (await page.getByTestId('assistant-message').count()) > 0;
    const sentWorkOff = drew && (await page.getByTestId('subagent-tool-row').count()) > 0;
    tried.push(
      `${past.externalId}: ${drew ? 'commands' : 'none'}${spoke ? ' and replies' : ''}${sentWorkOff ? ' and subagents' : ''}`,
    );
    if (!drew || !spoke) continue;
    if (sentWorkOff) return { project, id: opened.id };
    fallback ??= { project, id: opened.id };
  }

  if (fallback) {
    await page.goto(`/project?id=${fallback.project.id}&tab=chat&chat=${fallback.id}`);
    await page.getByTestId('chat-tab').waitFor({ timeout: OPEN_MS });
    await commandRows(page).first().waitFor({ timeout: 20_000 });
    return fallback;
  }

  test.skip(true, `no past chat on this instance drew both commands and replies: ${tried.join('; ')}`);
  throw new Error('unreachable');
}

/**
 * Every command row the conversation drew.
 *
 * A command a subagent ran is drawn indented under the one that sent it off and
 * carries its own name in the record, so the tree counts it like any other —
 * and a check that counts only the top-level ones is comparing its number
 * against a different set of rows than the tree's, which comes apart on any
 * conversation that dispatched a subagent (bw-qdim.12).
 */
const commandRows = (page: Page) =>
  page.locator('[data-testid="tool-row"], [data-testid="subagent-tool-row"]');

/**
 * Only the rows at the top of the conversation.
 *
 * Arithmetic about what one switch hid belongs here: switching a tool off takes
 * the work its rows spawned with them, so the number of INDENTED rows left
 * standing is not `before - mine` — while a top-level row is hidden by its own
 * switch and nothing else.
 */
const topRows = (page: Page) => page.getByTestId('tool-row');

/**
 * A hook on this run's own kit, so a chat that has said nothing still has the
 * machine talking in it.
 *
 * What the owner's chats have and a bare instance does not: his kit fires hooks
 * the moment a chat starts, and their lines are the rows that were being called
 * switched off. One echo is enough — the check is that they are HIDDEN and
 * unremarked, not what they say.
 */
function aHookOnEveryChat(): () => void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'settings.json');
  writeFileSync(
    path,
    JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo a hook said something' }] }],
      },
    }) + '\n',
  );
  return () => rmSync(path, { force: true });
}

/**
 * Somewhere to start a chat: whatever the instance already lists, or a
 * throwaway of this run's own where it lists none — which is what the isolated
 * stack gives, its data folder being a minute old. One it made, it takes away.
 */
async function somewhereToChat(
  request: APIRequestContext,
): Promise<{ project: Project; done: () => Promise<void> }> {
  const api = backend();
  const listed = (await (await request.get(`${api}/api/projects`)).json()) as Project[];
  if (listed.length > 0) return { project: pickProject(listed), done: async () => {} };

  const dir = mkdtempSync(join(tmpdir(), 'atelier-nothing-said-'));
  execFileSync('git', ['init', '-q', '.'], { cwd: dir, stdio: 'pipe' });
  const made = await request.post(`${api}/api/projects`, {
    data: { name: 'A chat with nothing said in it', path: dir },
  });
  expect(made.ok(), 'the instance refused a project of this run’s own').toBe(true);
  const project = { ...((await made.json()) as Project), path: dir };
  return {
    project,
    done: async () => {
      await request.delete(`${api}/api/projects/${project.id}`);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The machine's own side of the status tree, which the quiet start switches off. */
const MACHINE = 'status:machine';

const line = (page: Page, kind: string) => page.locator(`[data-testid="kind-line"][data-kind="${kind}"]`);
const switchOn = (page: Page, kind: string) => line(page, kind).getByTestId('kind-switch');
const foldOn = (page: Page, kind: string) => line(page, kind).getByTestId('kind-fold');

async function openTheFilter(page: Page): Promise<void> {
  await page.getByTestId('open-kind-filter').click();
  await page.getByTestId('kind-tree').waitFor();
}

/**
 * Waits until the conversation has stopped arriving.
 *
 * A chat read in from its record streams onto the page, so counting its rows
 * the moment it opens counts a conversation still half drawn — which is what
 * made the counts case read 41 rows against a tree that already knew about 69.
 */
async function settled(page: Page): Promise<number> {
  let last = -1;
  await expect
    .poll(
      async () => {
        const now = await commandRows(page).count();
        const still = now === last && now > 0;
        last = now;
        return still;
      },
      { timeout: 60_000, intervals: [500] },
    )
    .toBe(true);
  return last;
}

/** The name on the first command row the screen drew. */
async function firstToolName(page: Page): Promise<string> {
  const name = await page.getByTestId('tool-row').first().getAttribute('data-tool-name');
  expect(name, 'the first command row carries no tool name').toBeTruthy();
  return name!;
}

test.describe('choosing which kinds of message show', () => {
  // Every case here first has to FIND a conversation with a real spread of
  // kinds in it, which means opening past chats until one draws both commands
  // and replies. That hunt is most of the time each case takes, and it is well
  // past the default a case is given.
  test.describe.configure({ timeout: 180_000 });

  test('the filter opens a tree with the agent’s kinds under him', async ({ page, request }) => {
    await aBusyChat(request, page);
    await openTheFilter(page);

    await expect(line(page, 'you')).toBeVisible();
    await expect(line(page, 'agent')).toBeVisible();
    for (const kind of ['replies', 'thinking', 'commands', 'status', 'questions', 'reports']) {
      await expect(line(page, kind)).toBeVisible();
    }

    // Commands arrives folded, and opens onto the tools this chat actually used.
    const tool = await firstToolName(page);
    await expect(line(page, `tool:${tool}`)).toHaveCount(0);
    await foldOn(page, 'commands').click();
    await expect(line(page, `tool:${tool}`)).toBeVisible();
  });

  test('turning commands off hides every command row and leaves the replies', async ({ page, request }) => {
    await aBusyChat(request, page);
    await settled(page);
    const replies = await page.getByTestId('assistant-message').count();

    await openTheFilter(page);
    await switchOn(page, 'commands').click();

    await expect(commandRows(page)).toHaveCount(0);
    await expect(page.getByTestId('assistant-message')).toHaveCount(replies);
    await expect(page.getByTestId('open-kind-filter')).toHaveAttribute('data-filtered', 'true');
  });

  test('turning one tool off hides only that tool’s rows', async ({ page, request }) => {
    await aBusyChat(request, page);
    const tool = await firstToolName(page);
    await settled(page);
    const before = await topRows(page).count();
    const mine = await topRows(page).and(page.locator(`[data-tool-name="${tool}"]`)).count();
    test.skip(mine === before, `this chat only ever ran ${tool}, so there is nothing to leave standing`);

    await openTheFilter(page);
    await foldOn(page, 'commands').click();
    await switchOn(page, `tool:${tool}`).click();

    // Gone wherever it ran — a subagent's own call to it as well as the
    // conversation's — and every other row at the top still standing.
    await expect(commandRows(page).and(page.locator(`[data-tool-name="${tool}"]`))).toHaveCount(0);
    await expect(topRows(page)).toHaveCount(before - mine);
  });

  test('a group whose children disagree draws half-on', async ({ page, request }) => {
    await aBusyChat(request, page);
    const tool = await firstToolName(page);
    await openTheFilter(page);
    await foldOn(page, 'commands').click();

    await expect(line(page, 'commands')).toHaveAttribute('data-state', 'on');
    await switchOn(page, `tool:${tool}`).click();

    await expect(line(page, `tool:${tool}`)).toHaveAttribute('data-state', 'off');
    await expect(line(page, 'commands')).toHaveAttribute('data-state', 'half');
    await expect(line(page, 'agent')).toHaveAttribute('data-state', 'half');
  });

  test('every switch says how many rows it matches', async ({ page, request }) => {
    await aBusyChat(request, page);
    const drawn = await settled(page);
    const replies = await page.getByTestId('assistant-message').count();

    await openTheFilter(page);
    await expect(line(page, 'commands')).toHaveAttribute('data-count', String(drawn));
    await expect(line(page, 'replies')).toHaveAttribute('data-count', String(replies));

    // Each tool's own number against the rows of that tool the conversation
    // drew — name by name rather than as one total, because two numbers that
    // add up to the same sum can still both be wrong.
    await foldOn(page, 'commands').click();
    const onScreen = new Map<string, number>();
    for (const name of await commandRows(page).evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-tool-name') ?? ''),
    )) {
      onScreen.set(name, (onScreen.get(name) ?? 0) + 1);
    }
    const said = await line(page, 'commands')
      .locator('xpath=following-sibling::*[starts-with(@data-kind,"tool:")]')
      .evaluateAll((els) =>
        els.map((el) => ({
          tool: (el.getAttribute('data-kind') ?? '').slice('tool:'.length),
          count: Number(el.getAttribute('data-count')),
        })),
      );
    expect(Object.fromEntries(said.map((s) => [s.tool, s.count]))).toEqual(Object.fromEntries(onScreen));
    expect(said.reduce((sum, s) => sum + s.count, 0)).toBe(drawn);
  });

  test('switching everything off says so, and hands the conversation back', async ({ page, request }) => {
    await aBusyChat(request, page);
    await openTheFilter(page);
    await switchOn(page, 'you').click();
    await switchOn(page, 'agent').click();

    await expect(page.getByTestId('nothing-showing')).toBeVisible();
    await expect(commandRows(page)).toHaveCount(0);
    await expect(page.getByTestId('assistant-message')).toHaveCount(0);

    await page.getByTestId('show-every-kind-back').click();
    await expect(page.getByTestId('nothing-showing')).toHaveCount(0);
    await expect(topRows(page).first()).toBeVisible();
    await expect(page.getByTestId('open-kind-filter')).toHaveAttribute('data-filtered', 'false');
  });

  test('a chat that has said nothing yet is not called switched off', async ({ page, request }) => {
    // The fault the owner reported: every new chat opened on a centred notice
    // saying all of its rows were switched off, over a button offering to undo
    // a default he never chose. Its only rows are the machine's own start-up
    // lines and the quiet start hides those before he has touched anything, so
    // the notice was speaking for the app's own choice as if it were his
    // (bw-aqpc).
    const { project, done } = await somewhereToChat(request);
    const noHook = aHookOnEveryChat();
    try {
      await page.goto(`/project?id=${project.id}&tab=chat`);
      await page.getByTestId('new-chat').click();
      await page.getByTestId('chat-tab').waitFor({ timeout: OPEN_MS });

      // Nothing is typed into it. What it holds is the machine's own, switched
      // off and counted — which is what stops this passing on a chat that has
      // no rows at all.
      await openTheFilter(page);
      await expect(line(page, MACHINE)).toHaveAttribute('data-state', 'off');
      await expect
        .poll(async () => Number(await line(page, MACHINE).getAttribute('data-count')), { timeout: 30_000 })
        .toBeGreaterThan(0);
      await page.keyboard.press('Escape');

      await expect(page.getByTestId('nothing-showing')).toHaveCount(0);
    } finally {
      noHook();
      await done();
    }
  });

  test('the choice survives a reload', async ({ page, request }) => {
    const { project, id } = await aBusyChat(request, page);
    await openTheFilter(page);
    await switchOn(page, 'commands').click();
    await expect(commandRows(page)).toHaveCount(0);

    // A way of reading, not a property of one conversation: it is remembered
    // for the browser, the way the open-everything switch beside it is.
    await page.goto(`/project?id=${project.id}&tab=chat&chat=${id}`);
    await page.getByTestId('chat-tab').waitFor({ timeout: OPEN_MS });
    await expect(page.getByTestId('open-kind-filter')).toHaveAttribute('data-filtered', 'true', { timeout: 30_000 });
    await expect(page.getByTestId('assistant-message').first()).toBeVisible({ timeout: 30_000 });
    await expect(commandRows(page)).toHaveCount(0);

    await openTheFilter(page);
    await expect(line(page, 'commands')).toHaveAttribute('data-state', 'off');
  });
});
