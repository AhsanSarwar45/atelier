import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { command } from './fixture-held';

/**
 * A push that needs an SSH key unlocked, driven end to end (bw-k778).
 *
 * Nothing here is a mock, including the ssh. The shared copy is reached over
 * the ssh transport at a host that does not exist, and the program git runs to
 * get there is a script this case writes: it asks for a passphrase the way ssh
 * asks — by running whatever `SSH_ASKPASS` names — refuses with ssh's own
 * `Permission denied (publickey)` when it does not get the right one, and when
 * it does, hands the connection on to `git-receive-pack` so the push really
 * happens. That is what the ssh transport is.
 *
 * So the last act is the one that matters: after the passphrase is typed into
 * the rail, this asks the shared copy itself, with `git log` in the bare
 * repository, whether the commit arrived. A panel that drew the prompt
 * beautifully and sent the passphrase nowhere would fail on that line.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/git-panel-unlocks-a-key.spec.ts
 */

/** Where a run leaves its proof; not the artifacts folder, which is emptied. */
const SHOTS = 'tests/results';

/** Opening a chat is a file read plus a wake; this is the whole way in. */
const WAY_IN_MS = 120_000;

const FIXTURE = join(__dirname, '..', '.git-key-run');
const SHARED = join(FIXTURE, 'shared.git');
const REPO = join(FIXTURE, 'repo');

/** The one the fake ssh will accept, and nothing else. */
const PASSPHRASE = 'open sesame';

/** The saved change that is waiting to be sent. */
const WAITING = 'a change that needs the key to get out';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Who this repository's commits are by; see the sibling case for why local. */
function settle(repo: string): void {
  git(repo, 'config', '--local', 'user.name', 'Git Key Fixture');
  git(repo, 'config', '--local', 'user.email', 'git-key-fixture@example.invalid');
  git(repo, 'config', '--local', 'commit.gpgsign', 'false');
  git(repo, 'config', '--local', 'core.hooksPath', join(FIXTURE, 'no-hooks'));
}

/**
 * An ssh that will not let anyone through without the passphrase, and does the
 * real thing once it has it.
 *
 * It reads the passphrase exactly as ssh does — by running the program named
 * in `SSH_ASKPASS` — which is the part of the server's work this is here to
 * exercise. With no such program named, or the wrong answer from it, it says
 * what ssh says and gives up with ssh's own status.
 */
function writeTheSshThatWantsAPassphrase(): string {
  const at = join(FIXTURE, 'ssh-that-wants-a-passphrase');
  writeFileSync(
    at,
    `#!/bin/sh
# Walk off ssh's own switches to reach the host and then the command git wants
# run on the other side.
host=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o|-i|-F|-p) shift 2 ;;
    -*) shift ;;
    *)
      if [ -z "$host" ]; then host="$1"; shift; else break; fi
      ;;
  esac
done
wanted="$*"

given=""
if [ -n "$SSH_ASKPASS" ] && [ -x "$SSH_ASKPASS" ]; then
  given=$("$SSH_ASKPASS" "Enter passphrase for key '/fixture/id_ed25519': ")
fi

if [ "$given" != "${PASSPHRASE}" ]; then
  echo "git@fixture-host: Permission denied (publickey)." >&2
  exit 255
fi

# The passphrase was right, so be the transport: run what git asked for.
eval exec $wanted
`,
    { mode: 0o755 },
  );
  chmodSync(at, 0o755);
  return at;
}

/**
 * A repository one saved change ahead of a shared copy it can only reach over
 * ssh.
 *
 * The upstream is set up over a plain path first and the remote is only then
 * pointed at the ssh host, so the branch has somewhere to follow without the
 * fixture having to get through its own locked door to arrange it.
 */
function seedRepository(): void {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(FIXTURE, 'no-hooks'), { recursive: true });

  git(FIXTURE, 'init', '--bare', '-b', 'main', SHARED);
  git(FIXTURE, 'clone', SHARED, REPO);
  settle(REPO);

  writeFileSync(join(REPO, 'README.md'), 'A project made by a test.\n');
  // The manifest, because the chat's own bar — and so the way into the Git
  // view — is only drawn on a project the app believes keeps a board: the tab
  // row itself is left off otherwise, and the button lives on it.
  mkdirSync(join(REPO, '.atelier'), { recursive: true });
  writeFileSync(
    join(REPO, '.atelier', 'project.toml'),
    ['schema_version = 1', '', '[project]', 'display_name = "git-key"', 'use_beads = true', ''].join('\n'),
  );
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-m', 'the files this project starts with');
  git(REPO, 'push', '--set-upstream', 'origin', 'main');

  // Now the only way out is through the key.
  const ssh = writeTheSshThatWantsAPassphrase();
  git(REPO, 'remote', 'set-url', 'origin', `fixture-host:${SHARED}`);
  git(REPO, 'config', '--local', 'core.sshCommand', ssh);

  writeFileSync(join(REPO, 'kept.txt'), 'Saved here, not sent yet.\n');
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-m', WAITING);
}

/** Whether the shared copy has the change that was waiting. */
function theSharedCopyHas(subject: string): boolean {
  return git(SHARED, 'log', '--format=%s', '-n', '20', 'main').split('\n').includes(subject);
}

/**
 * A project of this case's own, pointed at that repository.
 *
 * Not marked as a test project: the chat page reads the plain list, a test
 * project is left off it, and the way into the Git view is only drawn once the
 * page knows which directory the chat is in. It is deleted again at the end.
 */
async function fixtureProject(request: APIRequestContext): Promise<{ id: string; path: string }> {
  const made = await request.post('/api/projects', { data: { name: 'git-key', path: REPO } });
  expect(made.status(), `could not make a project: ${await made.text()}`).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

test.describe('a push that needs the key unlocked', () => {
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    seedRepository();
  });

  test.afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  test('asks for the passphrase, and the push it then makes reaches the shared copy', async ({
    page,
    request,
  }) => {
    expect(theSharedCopyHas(WAITING), 'the fixture starts with the change already sent').toBe(false);

    const project = await fixtureProject(request);
    // A chat of this case's own, started through the app rather than adopted
    // from a record on disk: the way into the Git view is a button on a chat's
    // bar, and this case is about what that view does, not about how a chat
    // comes to exist. Nothing is said in it — an empty chat is a chat.
    const started = await command(request, {
      type: 'session.start',
      projectId: project.id,
      projectPath: project.path,
      brand: 'claude',
    });
    expect(started.ok, started.body).toBe(true);
    const sessionId = started.said.id!;

    try {
      // The rail opened on Git, set the way the button on the bar sets it —
      // these are the app's own two remembered choices, written before the
      // page loads so it comes up already showing the view under test rather
      // than being clicked into it afterwards.
      await page.addInitScript(() => {
        localStorage.setItem('workbench.right-rail', '1');
        localStorage.setItem('workbench.git-panel', '1');
      });
      await page.goto(`/project?id=${project.id}&tab=chat&chat=${sessionId}`);
      await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });

      const view = page.getByTestId('git-view');
      await expect(view, 'the rail opened on something other than Git').toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId('git-branch-name')).toHaveText('main', { timeout: 30_000 });

      // ---- the locked door --------------------------------------------------
      // The key is locked and no agent holds it, so this is the push that used
      // to fail where nobody could answer it.
      await page.getByTestId('git-push').click();

      const asking = page.getByTestId('git-passphrase');
      await expect(asking, 'the panel did not offer to unlock the key').toBeVisible({
        timeout: 60_000,
      });
      // Only the prompt: a locked key is a question, not a failure, so the red
      // panel of ssh's stderr is not drawn over the box that answers it
      // (bw-8nwh.1).
      await expect(
        page.getByTestId('git-error'),
        'an error was drawn beside the passphrase prompt',
      ).toHaveCount(0);
      await page.locator('[data-testid="chat-right-rail"]').screenshot({
        path: `${SHOTS}/a-locked-key-is-asked-about.png`,
      });

      // A wrong one is refused, and nothing of it is kept.
      await page.getByLabel('SSH key passphrase').fill('not the passphrase');
      await page.getByTestId('git-unlock').click();
      await expect(asking, 'a wrong passphrase should leave the panel still asking').toBeVisible();
      await expect(
        page.getByLabel('SSH key passphrase'),
        'the panel kept a passphrase that did not work',
      ).toHaveValue('', { timeout: 30_000 });
      // Said inside the prompt, in one plain sentence — still no red panel.
      await expect(
        page.getByTestId('git-passphrase-refused'),
        'nothing said about the passphrase that did not work',
      ).toContainText('That passphrase did not unlock the key', { timeout: 30_000 });
      await expect(
        page.getByTestId('git-error'),
        'a refused passphrase drew the red panel instead of saying so in the prompt',
      ).toHaveCount(0);
      expect(theSharedCopyHas(WAITING), 'a wrong passphrase pushed anyway').toBe(false);

      // ---- and the right one ------------------------------------------------
      await page.getByLabel('SSH key passphrase').fill(PASSPHRASE);
      await page.getByTestId('git-unlock').click();

      await expect(asking, 'the panel is still asking after the key opened').toBeHidden({
        timeout: 60_000,
      });
      await expect(page.getByTestId('git-ahead'), 'the branch is still ahead').toHaveAttribute(
        'data-count',
        '0',
        { timeout: 30_000 },
      );
      await page.locator('[data-testid="chat-right-rail"]').screenshot({
        path: `${SHOTS}/the-key-opened-and-the-push-went.png`,
      });

      // The whole point: git itself, in the shared copy, has the change.
      expect(
        theSharedCopyHas(WAITING),
        'the passphrase was taken but the push never reached the shared copy',
      ).toBe(true);
    } finally {
      await command(request, { type: 'session.close', sessionId });
      await request.delete(`/api/projects/${project.id}`);
    }
  });
});
