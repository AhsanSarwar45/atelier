import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

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
    tried.push(`${past.externalId}: ${drew ? 'commands' : 'none'}${spoke ? ' and replies' : ''}`);
    if (drew && spoke) return { project, id: opened.id };
  }

  test.skip(true, `no past chat on this instance drew both commands and replies: ${tried.join('; ')}`);
  throw new Error('unreachable');
}

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
        const now = await page.getByTestId('tool-row').count();
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

    await expect(page.getByTestId('tool-row')).toHaveCount(0);
    await expect(page.getByTestId('assistant-message')).toHaveCount(replies);
    await expect(page.getByTestId('open-kind-filter')).toHaveAttribute('data-filtered', 'true');
  });

  test('turning one tool off hides only that tool’s rows', async ({ page, request }) => {
    await aBusyChat(request, page);
    const tool = await firstToolName(page);
    const before = await settled(page);
    const mine = await page.locator(`[data-testid="tool-row"][data-tool-name="${tool}"]`).count();
    test.skip(mine === before, `this chat only ever ran ${tool}, so there is nothing to leave standing`);

    await openTheFilter(page);
    await foldOn(page, 'commands').click();
    await switchOn(page, `tool:${tool}`).click();

    await expect(page.locator(`[data-testid="tool-row"][data-tool-name="${tool}"]`)).toHaveCount(0);
    await expect(page.getByTestId('tool-row')).toHaveCount(before - mine);
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

    // The commands group is the sum of the tools under it, which is what makes
    // the number worth reading.
    await foldOn(page, 'commands').click();
    const counts = await line(page, 'commands')
      .locator('xpath=following-sibling::*[starts-with(@data-kind,"tool:")]')
      .evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-count'))));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(drawn);
  });

  test('switching everything off says so, and hands the conversation back', async ({ page, request }) => {
    await aBusyChat(request, page);
    await openTheFilter(page);
    await switchOn(page, 'you').click();
    await switchOn(page, 'agent').click();

    await expect(page.getByTestId('nothing-showing')).toBeVisible();
    await expect(page.getByTestId('tool-row')).toHaveCount(0);
    await expect(page.getByTestId('assistant-message')).toHaveCount(0);

    await page.getByTestId('show-every-kind-back').click();
    await expect(page.getByTestId('nothing-showing')).toHaveCount(0);
    await expect(page.getByTestId('tool-row').first()).toBeVisible();
    await expect(page.getByTestId('open-kind-filter')).toHaveAttribute('data-filtered', 'false');
  });

  test('the choice survives a reload', async ({ page, request }) => {
    const { project, id } = await aBusyChat(request, page);
    await openTheFilter(page);
    await switchOn(page, 'commands').click();
    await expect(page.getByTestId('tool-row')).toHaveCount(0);

    // A way of reading, not a property of one conversation: it is remembered
    // for the browser, the way the open-everything switch beside it is.
    await page.goto(`/project?id=${project.id}&tab=chat&chat=${id}`);
    await page.getByTestId('chat-tab').waitFor({ timeout: OPEN_MS });
    await expect(page.getByTestId('open-kind-filter')).toHaveAttribute('data-filtered', 'true', { timeout: 30_000 });
    await expect(page.getByTestId('assistant-message').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('tool-row')).toHaveCount(0);

    await openTheFilter(page);
    await expect(line(page, 'commands')).toHaveAttribute('data-state', 'off');
  });
});
