import { expect, test } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The Chat tab, on a computer that has never held this project's source.
 *
 * `scripts/release-runs-anywhere.sh` asks the same question of the API. This
 * one asks it of the screen, because the screen is where the fault showed:
 * the helper used to be started from the checkout it was BUILT in, so on
 * anybody else's machine the tab drew an empty list with an error over it and
 * nothing behind it (bw-8um.3.9).
 *
 * Nothing here touches the reader's own copy of the app. One file is copied
 * out of the build, given a home directory made a second ago and two ports
 * picked at run time, and every assertion is made against that.
 *
 * What the fresh home DOES get is the reader's own Claude Code sign-in, linked
 * in. That is not a hole in the check — it is the case being checked. A friend
 * who installs this binary is signed into Claude Code and has no copy of our
 * source; the helper is the thing that has to arrive inside the binary, and the
 * agent it drives is deliberately theirs (workbench/src/claude-program.ts).
 *
 * Run: npx playwright test tests/e2e/chat-on-a-clean-machine.spec.ts
 * ATELIER_BINARY names a release binary to use instead of the built one.
 */

/** The first run fetches the one kit the helper does not carry. That costs the network, once. */
const FIRST_RUN_MS = 240_000;

/** A real turn: a model answering over the network. */
const A_TURN_MS = 180_000;

/** Nothing to read, nothing to run — the shortest turn there is. */
const ASK = 'Reply with exactly one word: READY.';

/** The reader's own Claude Code sign-in, which an installed copy would have. */
const SIGNED_IN = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');

const BINARY = process.env.ATELIER_BINARY ?? join(process.cwd(), 'server/target/release/atelier');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

async function answers(url: string, within: number): Promise<boolean> {
  const until = Date.now() + within;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // Not up yet.
    }
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** A repository for the fresh copy to open — the reader's own work, not ours. */
function aProjectOfTheirOwn(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'clean@example.invalid'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'a clean machine'], { cwd: dir, stdio: 'pipe' });
  try {
    execFileSync('bd', ['init', '--prefix', 'cm'], { cwd: dir, stdio: 'pipe', timeout: 60_000 });
  } catch {
    // No tracker on this machine. The Chat tab does not need one.
  }
}

let work = '';
let installed: ChildProcess | null = null;
let base = '';
let sidecarPort = 0;
let projectId = '';

test.describe('the chat on a computer that has never held this source', () => {
  test.describe.configure({ mode: 'serial', timeout: FIRST_RUN_MS + 120_000 });

  test.beforeAll(async () => {
    test.skip(
      !existsSync(BINARY),
      `no release binary at ${BINARY} — run 'npm run build && cd server && cargo build --release'`,
    );

    test.skip(
      !existsSync(SIGNED_IN),
      `no Claude Code sign-in at ${SIGNED_IN} — the chat has no agent to drive`,
    );

    work = mkdtempSync(join(tmpdir(), 'atelier-clean-'));
    const home = join(work, 'home');
    mkdirSync(home, { recursive: true });
    // The one thing carried over from the real home. Everything else about
    // this machine — our source, our build, our settings — is absent.
    symlinkSync(SIGNED_IN, join(home, '.claude'));
    const port = await freePort();
    sidecarPort = await freePort();
    base = `http://127.0.0.1:${port}`;

    // Only what a program on a stranger's computer would have. Every switch
    // this project's own sessions export — and CARGO_MANIFEST_DIR, which is
    // what used to point the helper back at the build machine — is absent
    // because it is not named here.
    const log = openSync(join(work, 'said.txt'), 'a');
    installed = spawn(BINARY, [], {
      cwd: work,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        ATELIER_HOST: '127.0.0.1',
        ATELIER_PORT: String(port),
        BEADS_WORKBENCH_PORT: String(sidecarPort),
      },
      stdio: ['ignore', log, log],
    });

    expect(await answers(`${base}/api/health`, 60_000), 'the fresh copy never served').toBe(true);
    expect(
      await answers(`${base}/api/workbench/health`, FIRST_RUN_MS),
      'the chat helper never came up behind the fresh copy',
    ).toBe(true);

    aProjectOfTheirOwn(join(work, 'their-project'));
    const made = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Not marked a test project: the screen reads the list that hides those,
      // and a hidden project draws "Pick a project to start a chat" instead of
      // the chat. It leaks nowhere — the whole install is the throwaway home
      // above, which this file deletes when it is done.
      body: JSON.stringify({ name: 'Their Project', path: join(work, 'their-project') }),
    });
    expect(made.ok, `the fresh copy refused a project (${made.status})`).toBe(true);
    projectId = ((await made.json()) as { id: string }).id;
  });

  test.afterAll(async () => {
    // By port and never by name: the reader's own Atelier is running on this
    // machine and a name-matching kill would take it down too.
    for (const pid of [installed?.pid, sidecarPid(sidecarPort)]) {
      if (!pid) continue;
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
    if (work) rmSync(work, { recursive: true, force: true });
  });

  test('the Chat tab answers a message', async ({ page }) => {
    test.setTimeout(A_TURN_MS + 120_000);
    await page.goto(`${base}/project?id=${projectId}&tab=chat`);

    const sidebar = page.getByTestId('chat-sidebar');
    await expect(sidebar, 'the chat pane never drew').toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('chat-list')).toBeVisible();

    // The fault this whole card is about draws exactly here: a red bar over an
    // empty list, because the thing the list reads from was never started.
    await expect(
      page.getByTestId('restore-error'),
      'the chat pane is showing an error, so the helper did not answer',
    ).toHaveCount(0);

    // And the helper answers for itself, not merely fails quietly.
    const listed = await fetch(`${base}/api/workbench/sessions`);
    expect(listed.ok, 'the helper did not answer for its own list of chats').toBe(true);

    // ---- a message, and an answer to it ---------------------------------
    await page.getByTestId('new-chat').click();
    await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('composer').fill(ASK);
    await page.getByTestId('send-button').click();

    const answer = page.getByTestId('assistant-message').first();
    await expect(answer, 'nothing answered the message').toBeVisible({ timeout: A_TURN_MS });
    await expect
      .poll(async () => ((await answer.textContent()) ?? '').trim().length, { timeout: A_TURN_MS })
      .toBeGreaterThan(0);

    mkdirSync('tests/results', { recursive: true });
    await page.screenshot({ path: 'tests/results/chat-clean-machine.png', fullPage: false });
  });
});

/** The helper the fresh copy started, found by the port it was told to listen on. */
function sidecarPid(port: number): number | null {
  try {
    const out = execFileSync('ss', ['-lntpH', `sport = :${port}`], { encoding: 'utf8' });
    const m = /pid=(\d+)/.exec(out);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
