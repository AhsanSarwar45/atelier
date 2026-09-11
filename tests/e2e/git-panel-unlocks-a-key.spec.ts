import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Locator } from '@playwright/test';

import { command } from './fixture-held';

/** Wait until a dialog has finished fading in, so a picture of it is honest. */
async function settled(dialog: Locator): Promise<void> {
  await expect
    .poll(async () => dialog.evaluate((box) => getComputedStyle(box).opacity), { timeout: 10_000 })
    .toBe('1');
}

/**
 * The same for a toast, which slides up from under the window rather than
 * fading: a picture taken while it is still on its way shows it half off the
 * bottom of the screen, which is a picture of the animation and not of the
 * app. Waited for by where it has come to rest, since its opacity is 1 for the
 * whole of the journey.
 */
async function landed(toast: Locator): Promise<void> {
  await expect
    .poll(
      async () =>
        toast.evaluate((box) => Math.round(box.getBoundingClientRect().bottom - window.innerHeight)),
      { timeout: 10_000 },
    )
    .toBeLessThanOrEqual(0);
}

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
batch=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o)
      case "$2" in BatchMode=yes) batch="yes" ;; esac
      shift 2
      ;;
    -i|-F|-p) shift 2 ;;
    -*) shift ;;
    *)
      if [ -z "$host" ]; then host="$1"; shift; else break; fi
      ;;
  esac
done
wanted="$*"

# Real ssh under \`BatchMode=yes\` never runs an askpass program, whoever named
# one. Honouring that here is not a nicety: a desktop session exports
# SSH_ASKPASS (KDE's ksshaskpass, say) into everything it starts, the server
# hands its whole environment to git, and without this line the no-passphrase
# call would put a graphical password box on somebody's screen and wait for a
# human who is not there — the run hangs rather than getting the refusal it is
# here to provoke.
given=""
if [ -z "$batch" ] && [ -n "$SSH_ASKPASS" ] && [ -x "$SSH_ASKPASS" ]; then
  given=$("$SSH_ASKPASS" "Enter passphrase for key '/fixture/id_ed25519': ")
fi

if [ "$given" != "${PASSPHRASE}" ]; then
  echo "git@fixture-host: Permission denied (publickey)." >&2
  exit 255
fi

# Long enough that the panel can be caught in the middle of the push, which
# is the whole of what bw-8qrr.2 is about: the reader must be told something
# is happening while a push runs, not left looking at a frozen dialog. Real
# pushes take far longer than this; three seconds is only enough for a test to
# see the same thing a reader sees for a minute.
sleep 3

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
      // The whole window, not the rail: the asking is the app's own modal
      // dialog now (bw-ahf2.1) and is drawn over the page rather than inside
      // the rail, so a crop of the rail would prove nothing about it. Waited
      // for first — a dialog caught in the middle of its own fade is a picture
      // of a half-drawn app, not of what a reader sees.
      await settled(asking);
      await page.screenshot({ path: `${SHOTS}/a-locked-key-is-asked-about.png` });

      // Escape is the same word as Cancel, now that the asking is the app's
      // own modal (bw-ahf2.1): the dialog goes, nothing is reported, and what
      // was half-typed is not waiting in the box next time.
      await page.getByLabel('SSH key passphrase').fill('half a passphrase');
      await page.keyboard.press('Escape');
      await expect(asking, 'Escape did not put the asking away').toHaveCount(0);
      await expect(page.getByTestId('git-error')).toHaveCount(0);
      await page.getByTestId('git-push').click();
      await expect(asking).toBeVisible({ timeout: 60_000 });
      await expect(
        page.getByLabel('SSH key passphrase'),
        'a passphrase escaped out of was kept for the next time',
      ).toHaveValue('');

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

      // A second in, with the push still running: the one moment the whole of
      // bw-8qrr.2 is about, photographed before anything is asserted about it
      // so that the same line can be run against the code as it was and the
      // two pictures put side by side.
      await page.waitForTimeout(1_200);
      await page.screenshot({ path: `${SHOTS}/the-moment-after-the-passphrase.png` });

      // The prompt goes at once, before the push it unlocked has finished
      // (bw-8qrr.2). It used to sit there for the whole of the push with its
      // field greyed out, which on a real push is minutes of an app that
      // looks hung. The fake ssh above sleeps for three seconds so that this
      // line means something: a dialog that waited for the call would still
      // be up.
      await expect(asking, 'the prompt waited for the push instead of getting out of the way')
        .toBeHidden({ timeout: 2_000 });

      // And the wait it left behind is carried by a toast, which is where the
      // reader can watch it from while looking at anything else on the page.
      const toast = page.getByTestId('toast');
      await expect(toast.getByTestId('toast-title'), 'nothing said the push was running')
        .toHaveText('Pushing');
      await expect(toast.getByTestId('toast-message')).toHaveText('main → origin/main');
      await landed(toast);
      await page.screenshot({ path: `${SHOTS}/a-push-says-it-is-running.png` });

      // The same toast becomes the answer.
      await expect(toast.getByTestId('toast-title'), 'the push never reported how it went')
        .toHaveText('Pushed', { timeout: 60_000 });
      await expect(page.getByTestId('git-ahead'), 'the branch is still ahead').toHaveAttribute(
        'data-count',
        '0',
        { timeout: 30_000 },
      );
      await landed(toast);
      await page.screenshot({ path: `${SHOTS}/a-push-that-worked-says-so.png` });
      await page.locator('[data-testid="chat-right-rail"]').screenshot({
        path: `${SHOTS}/the-key-opened-and-the-push-went.png`,
      });

      // The whole point: git itself, in the shared copy, has the change.
      expect(
        theSharedCopyHas(WAITING),
        'the passphrase was taken but the push never reached the shared copy',
      ).toBe(true);

      // ---- and a failure no key would clear -----------------------------
      // Pointed at a shared copy that is not there, so the next push fails for
      // a reason the passphrase prompt has nothing to do with. That is the
      // other half of bw-8qrr.3: the panel has to say a push failed, and say
      // why, in the same place it said it worked.
      git(REPO, 'remote', 'set-url', 'origin', join(FIXTURE, 'no-such-copy.git'));
      writeFileSync(join(REPO, 'kept.txt'), 'Changed again.\n');
      git(REPO, 'add', '-A');
      git(REPO, 'commit', '-m', 'one that cannot get out');
      await page.getByTestId('git-refresh').click();
      await expect(page.getByTestId('git-ahead')).toHaveAttribute('data-count', '1', {
        timeout: 30_000,
      });

      await page.getByTestId('git-push').click();
      await expect(toast.getByTestId('toast-title'), 'a failed push said nothing at all')
        .toHaveText('Push failed', { timeout: 60_000 });
      // A label and one line of git's, not a wall of stderr: the wall is still
      // in the panel underneath for anyone who wants to read it.
      await expect(toast.getByTestId('toast-message')).toContainText('does not appear to be a git repository');
      await expect(page.getByTestId('git-error'), "git's own words are still kept in the panel")
        .toBeVisible();
      await landed(toast);
      await page.screenshot({ path: `${SHOTS}/a-push-that-failed-says-why.png` });

      // And the reason survives the panel's own five-second re-read, which is
      // what used to wipe it off the screen before it could be read
      // (bw-8qrr.1).
      await page.waitForTimeout(7_000);
      await expect(
        page.getByTestId('git-error'),
        'the re-read wiped the reason for the failure off the screen',
      ).toBeVisible();
    } finally {
      await command(request, { type: 'session.close', sessionId });
      await request.delete(`/api/projects/${project.id}`);
    }
  });
});
