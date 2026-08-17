import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The chat draws everything the agent does.
 *
 * The manager's fault, 2026-08-17: `/compact` answered and he saw nothing, the
 * commands the agent ran had no output on them, and picking bypass in the mode
 * menu came back as a 500. What must hold now is that nothing the kit sends is
 * dropped, that a command opens onto what it ran and printed, and that one
 * control opens the lot (docs/agent-workbench.md §8.2.4).
 *
 * Run: BEADS_E2E_URL=http://127.0.0.1:3017 BEADS_E2E_BACKEND=http://127.0.0.1:3018 \
 *      npx playwright test tests/e2e/chat-everything.spec.ts
 */

/** Starting an agent and hearing back what it can do is a process launch. */
const HELLO_MS = 120_000;
/** A turn that runs a command and comes back. */
const TURN_MS = 180_000;

function backend(): string {
  return process.env.BEADS_E2E_BACKEND ?? '';
}

interface Project {
  id: string;
  path: string;
}

function pickProject(projects: Project[]): Project {
  expect(projects.length, 'the instance lists no projects').toBeGreaterThan(0);
  return process.env.BEADS_E2E_PROJECT
    ? projects.find((p) => p.id === process.env.BEADS_E2E_PROJECT)!
    : projects[0]!;
}

/** A chat of its own for this case, with nothing said in it. */
async function freshChat(request: APIRequestContext, page: Page): Promise<{ project: Project; id: string }> {
  const api = backend();
  const projects = (await (await request.get(`${api}/api/projects`)).json()) as Project[];
  const project = pickProject(projects);

  const started = (await (
    await request.post(`${api}/api/workbench/command`, {
      data: { type: 'session.start', projectId: project.id, projectPath: project.path, brand: 'claude' },
    })
  ).json()) as { id: string };

  await page.goto(`/project?id=${project.id}&tab=chat&chat=${started.id}`);
  await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
  // The menus arrive when the session announces itself; nothing is steerable
  // before that, and a case that clicks too early is testing the clock.
  await page.getByTestId('mode-picker').waitFor({ timeout: HELLO_MS });
  return { project, id: started.id };
}

/**
 * Sends one turn and waits for it to be on the page.
 *
 * Escape first, because a line starting with `/` opens the command menu and
 * Enter would pick an entry out of it rather than send anything (§7). What each
 * case then waits for is its OWN evidence: waiting to SEE the chat busy races a
 * local command, which answers before a screen can be sampled.
 */
/**
 * Lets this chat run a command without stopping to ask.
 *
 * Through the picker, because that is the path the manager uses and the mode
 * the kit refused outright before this job (§3.1) — a case that needs a command
 * to have run is also the case that proves the switch took.
 */
async function letItRun(page: Page): Promise<void> {
  const picker = page.getByTestId('mode-picker');
  await picker.click();
  await page.locator('[data-testid="mode-picker-option"][data-value="bypassPermissions"]').click();
  await expect.poll(async () => picker.getAttribute('data-current'), { timeout: 60_000 }).toBe('bypassPermissions');
}

async function say(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer').fill(text);
  await page.getByTestId('composer').press('Escape');
  await page.getByTestId('composer').press('Enter');
  await expect(page.getByTestId('user-message').filter({ hasText: text })).toBeVisible({ timeout: 60_000 });
}

test.describe('the chat draws everything the agent does', () => {
  test.describe.configure({ timeout: 420_000 });

  test('the mode picker takes bypass, and says so in the chat', async ({ page, request }) => {
    await freshChat(request, page);

    const picker = page.getByTestId('mode-picker');
    await picker.click();
    const bypass = page.locator('[data-testid="mode-picker-option"][data-value="bypassPermissions"]');
    await bypass.waitFor({ timeout: 30_000 });
    await bypass.click();

    // The mode the kit refused outright until the session was launched with
    // permission to switch (bw-1u1, §3.1).
    await expect.poll(async () => picker.getAttribute('data-current'), { timeout: 60_000 }).toBe('bypassPermissions');
    await expect(page.getByTestId('steer-error')).toBeHidden();
    // A chat that quietly stopped asking about tools is a trap, so it is said.
    await expect(page.getByTestId('note-row').filter({ hasText: 'bypassPermissions' })).toBeVisible({
      timeout: 30_000,
    });
  });

  test('compact says why it could not, instead of saying nothing', async ({ page, request }) => {
    await freshChat(request, page);
    await say(page, '/compact');

    // The answer the kit sent twice and the chat drew neither time. A chat this
    // short cannot be compacted, so what must appear is the reason.
    await expect(page.getByTestId('note-row').filter({ hasText: /compact/i }).first()).toBeVisible({
      timeout: TURN_MS,
    });
  });

  test('a message with no stream behind it is drawn, and only once', async ({ page, request }) => {
    await freshChat(request, page);
    await say(page, '/compact');
    await page.getByTestId('note-row').filter({ hasText: /compact/i }).first().waitFor({ timeout: TURN_MS });

    // The kit reports this in two shapes — a status and a message it wrote
    // itself. Both are kept; one is read. Text has only ever come off the
    // stream, and a message the kit writes never streams (§8.2.4).
    const said = await page
      .getByTestId('transcript')
      .evaluate((el) => (el.textContent ?? '').match(/not enough messages to compact/gi)?.length ?? 0);
    expect(said, 'the same sentence was drawn more than once').toBeLessThanOrEqual(1);
    await expect(page.getByTestId('transcript')).toContainText(/compact/i);
    // And his own turn is still drawn exactly once beside it.
    await expect(page.getByTestId('user-message').filter({ hasText: '/compact' })).toHaveCount(1);
  });

  test('a command row opens onto what it ran and what it printed', async ({ page, request }) => {
    await freshChat(request, page);
    await letItRun(page);
    await say(page, 'Run exactly this in the shell and say nothing else: echo beads-web-was-here');

    const row = page.getByTestId('tool-row').filter({ hasText: 'Bash' }).first();
    await row.waitFor({ timeout: TURN_MS });
    // Shut to begin with: a transcript of open command bodies is unreadable.
    await expect(row).toHaveAttribute('data-open', 'false');

    await row.getByTestId('tool-toggle').click();
    await expect(row).toHaveAttribute('data-open', 'true');
    // What it was asked to do, and what came back — the half the browser used
    // to throw away (bw-1u1).
    await expect(row.getByTestId('tool-input')).toContainText('echo beads-web-was-here');
    await expect(row.getByTestId('tool-output')).toContainText('beads-web-was-here');
  });

  test('one control opens everything, and it is remembered', async ({ page, request }) => {
    const { project, id } = await freshChat(request, page);
    await letItRun(page);
    await say(page, 'Run exactly this in the shell and say nothing else: echo opened-by-one-key');

    const row = page.getByTestId('tool-row').first();
    await row.waitFor({ timeout: TURN_MS });
    await expect(row).toHaveAttribute('data-open', 'false');

    // Ctrl+O, because that is the key that does it in his terminal.
    await page.keyboard.press('Control+o');
    await expect(row).toHaveAttribute('data-open', 'true');
    await expect(page.getByTestId('toggle-open-all')).toHaveAttribute('data-open-all', 'true');

    // A way of reading, not a property of one chat: it survives a reload.
    await page.goto(`/project?id=${project.id}&tab=chat&chat=${id}`);
    await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
    await expect(page.getByTestId('toggle-open-all')).toHaveAttribute('data-open-all', 'true', { timeout: 30_000 });
    await expect(page.getByTestId('tool-row').first()).toHaveAttribute('data-open', 'true', { timeout: 60_000 });

    // Put back, so a later case does not inherit a transcript with everything open.
    await page.keyboard.press('Control+o');
    await expect(page.getByTestId('toggle-open-all')).toHaveAttribute('data-open-all', 'false');
  });

  test('putting the command list away keeps what he typed', async ({ page, request }) => {
    await freshChat(request, page);

    await page.getByTestId('composer').fill('/compact');
    await page.getByTestId('command-menu').waitFor({ timeout: 60_000 });
    await page.getByTestId('composer').press('Escape');

    // The list goes; the line stays. Escape used to empty the box, so a command
    // he meant to send exactly as typed could not be sent at all (bw-1u1.14).
    await expect(page.getByTestId('command-menu')).toBeHidden();
    await expect(page.getByTestId('composer')).toHaveValue('/compact');
  });

  test('a remembered way of reading survives a reload', async ({ page, request }) => {
    const { project, id } = await freshChat(request, page);

    // The sibling of the control above, and it had the same fault: a way of
    // reading written back from an effect is overwritten by the value the
    // screen started at, so it never survived a reload (bw-1u1.13).
    const button = page.getByTestId('toggle-everything');
    const before = await button.getAttribute('data-showing-everything');
    await button.click();
    const after = before === 'true' ? 'false' : 'true';
    await expect(button).toHaveAttribute('data-showing-everything', after);

    await page.goto(`/project?id=${project.id}&tab=chat&chat=${id}`);
    await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
    await expect(button).toHaveAttribute('data-showing-everything', after, { timeout: 30_000 });

    // Put back, so a later case starts where a chat normally starts.
    await button.click();
    await expect(button).toHaveAttribute('data-showing-everything', before ?? 'false');
  });

  test('an imported chat draws its commands, not only its sentences', async ({ page, request }) => {
    const api = backend();
    const projects = (await (await request.get(`${api}/api/projects`)).json()) as Project[];
    const project = pickProject(projects);
    const q = new URLSearchParams({ project: project.id, path: project.path });
    const rows = (await (await request.get(`${api}/api/workbench/restore?${q}`)).json()) as {
      sessionId: string | null;
      externalId: string | null;
      origin: string;
      title: string | null;
    }[];
    // A chat that ran in his terminal and has words in it, so it has almost
    // certainly run something too.
    const past = rows.find((r) => r.origin === 'terminal' && r.externalId && r.title);
    test.skip(!past, 'no past terminal chat on this instance');

    // Opened, which reads it and starts nothing (docs/designs/app-shell.md §1.9).
    const opened = (await (
      await request.post(`${api}/api/workbench/command`, {
        data: {
          type: 'session.open',
          sessionId: past!.sessionId ?? undefined,
          externalId: past!.externalId,
          brand: 'claude',
          projectId: project.id,
          projectPath: project.path,
        },
      })
    ).json()) as { id: string };

    await page.goto(`/project?id=${project.id}&tab=chat&chat=${opened.id}`);
    await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });

    // The manager's screenshot: the same chat drawn in his terminal showed every
    // command and its output, and drawn here showed sentences alone (§6.3.2).
    const commands = page.getByTestId('tool-row');
    await expect.poll(async () => commands.count(), { timeout: 90_000 }).toBeGreaterThan(0);

    const first = commands.first();
    await first.getByTestId('tool-toggle').click();
    await expect(first).toHaveAttribute('data-open', 'true');
    // Its result came out of the record with it, so an old command opens the
    // same way a live one does.
    await expect(first.getByTestId('tool-input').or(first.getByTestId('tool-output')).first()).toBeVisible();
  });
});
