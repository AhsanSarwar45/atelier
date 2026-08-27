/**
 * Every command a chat runs says what it did, and a delete says so wherever it hides.
 *
 * The manager's complaint, 2026-08-24: "whenever claude runs commands, it shows
 * as those raw commands and its difficult for reader to know what it is". Seven
 * of every ten rows in a chat was a shell command printed as itself and cut at
 * sixty characters, so the row he most wanted to skim was the one he had to
 * parse.
 *
 * The rules are in said-what-it-ran.ts and each one was written against a
 * number measured over his own record — 2,740 sessions, 68,827 shell commands.
 * This holds every rule to the sentence it promised. Three of them are not
 * taste and would each have put a wrong sentence in front of him:
 *
 *  - A folder change is where a command ran, never what it did. A quarter of
 *    his commands open with one, and naming it named nothing.
 *  - Cutting output down — `| head -20` — is how a command is read, not a
 *    second thing it did, so it must not turn up as "and 1 more".
 *  - A delete, kill or force-push always reaches the sentence, whichever link
 *    of the chain it sits in. A reader cannot tell a wrong sentence from a
 *    right one, so a friendly line that hid an `rm` would be worse than the raw
 *    shell it replaced.
 *
 * What this cannot see is whether the table still covers his real record, and
 * that is the replay check's job (scripts/chat-says-what-it-ran.mjs).
 */
import { describe, expect, it } from 'vitest';

import { COMMAND_KEPT, cut, KEPT, trimInput } from '@/workbench/imported-history';
import {
  KNOWN_TOOLS,
  RAN_KINDS,
  rawTitle,
  toolTitle,
  whatACommandDid,
  whatItRan,
  whileItRuns,
} from '@/workbench/said-what-it-ran';

/** A word that came off the wire rather than out of anyone's mouth. */
const OFF_THE_WIRE = /\b\w*(?:_\w+|[a-z][A-Z])\w*\b/g;

/**
 * The wire-shaped words a sentence added of its own.
 *
 * A pattern or a path the reader typed himself is kept verbatim on purpose —
 * `Searched for toolTitle` has to say `toolTitle`, and the chip that turns a
 * path into a link needs it byte for byte. What must never happen is a rule
 * reaching into a flag or a subcommand for its wording and handing him back
 * `force_with_lease`. So a wire-shaped word is only allowed here if he wrote
 * it in the first place.
 */
const SPOKEN = ['GitHub', 'JavaScript', 'TypeScript', 'JSON', 'YouTube'];

const invented = (sentence: string, asked: string) =>
  (sentence.match(OFF_THE_WIRE) ?? [])
    .filter((word) => asked.indexOf(word) < 0 && SPOKEN.indexOf(word) < 0);

/** What a command says it did. */
const said = (command: string) => whatACommandDid(command)?.said ?? null;

/** One command per rule, and the sentence that rule owes the reader. */
const RULES: Array<[string, string]> = [
  // The board this repo runs on. Every card id is kept exactly as written, so
  // the chip that turns it into a link still finds it (split-paths.tsx).
  ['bd close bw-7dqe.1', 'Closed bw-7dqe.1'],
  ['bd show bw-7ks.24', 'Showed bw-7ks.24'],
  ['bd ready', 'Listed the work that is ready'],
  ['bd list', 'Listed the board'],
  ['bd blocked', 'Listed what is blocked'],
  ['bd prime', 'Read the board rules'],
  ['bd stats', 'Counted the board'],
  ['bd update bw-7ks.24.2 --claim', 'Claimed bw-7ks.24.2'],
  ['bd update bw-7ks.24.2 --status=in_progress', 'Moved bw-7ks.24.2'],
  ['bd update bw-7ks.24.2 --append-notes "x"', 'Wrote a note on bw-7ks.24.2'],
  ['bd comments add bw-7ks.24 "note"', 'Commented on bw-7ks.24'],
  ['bd comments list bw-7ks.24', 'Read the comments on bw-7ks.24'],
  ['bd dep relate bw-a bw-b', 'Linked bw-a and bw-b'],
  ['bd merge-slot acquire', 'Took the merge slot'],
  ['bd merge-slot release', 'Gave the merge slot back'],
  ['bd remember "x"', 'Wrote a note to the board'],
  ['const r = await tools.exec_command({"cmd":"git status --short"}); text(r.output)', 'Checked the working tree'],
  ['const r = await tools.write_stdin({"session_id":12,"chars":""}); text(r.output)', 'Waited for a running command'],
  ['const patch = "*** Begin Patch\\n*** Update File: /repo/src/a.ts\\n*** End Patch"; await tools.apply_patch(patch)', 'Changed src/a.ts'],
  ['const r = await tools.view_image({"path":"/tmp/screen.png"})', 'Looked at tmp/screen.png'],
  ['const r = await tools.web__run({"search_query":[{"q":"Codex docs"}]})', 'Searched the web'],
  ["/bin/bash -lc 'bd ready'", 'Listed the work that is ready'],
  ["/bin/bash -lc 'sed -n \"1,240p\" .agents/skills/beads/SKILL.md && bd prime'", 'Read part of beads/SKILL.md, then read the board rules'],
  ['/bin/bash -lc "printf \'%s\' \'{\\"tool_name\\":\\"Bash\\"}\' | python3 machinery/hooks/workflow-gate.py"', 'Ran workflow-gate.py'],
  ["/bin/bash -lc \"git status --short; rg -n 'review|merge' AGENTS.md\"", 'Checked the working tree, then searched for review|merge in AGENTS.md'],
  ['machinery/board/job new --what x', 'Opened a job'],
  ['machinery/board/job under bw-7ks.24 --do "what to do|how we know"', 'Added the work items'],
  ['machinery/board/land bw-7ks.24', 'Landed bw-7ks.24'],
  ['machinery/board/review bw-7ks.24', 'Reviewed bw-7ks.24'],

  // Version control.
  ['git status', 'Checked the working tree'],
  ['git -C /home/me/project status --short', 'Checked the working tree'],
  ['git -c color.ui=false log --oneline', 'Read the history'],
  ['git --git-dir=/tmp/repo/.git --work-tree=/tmp/repo diff', 'Diffed the changes'],
  ['git log --oneline -20', 'Read the history'],
  ['git show HEAD', 'Showed HEAD'],
  ['git diff package-lock.json', 'Diffed package-lock.json'],
  ['git add -A', 'Staged everything'],
  ['git add src/a.ts', 'Staged src/a.ts'],
  ['git commit -m "x"', 'Committed'],
  ['git pull', 'Pulled'],
  ['git fetch --all', 'Fetched'],
  ['git checkout main', 'Checked out main'],
  ['git switch -c foo', 'Switched to foo'],
  ['git branch -a', 'Listed the branches'],
  ['git merge main', 'Merged main'],
  ['git rebase main', 'Rebased onto main'],
  ['git stash', 'Stashed the changes'],
  ['git stash pop', 'Took the stash back'],
  ['git reset', 'Unstaged the changes'],
  ['git restore src/x.ts', 'Restored src/x.ts'],
  ['git blame src/x.ts', 'Blamed src/x.ts'],
  ['git worktree add worktrees/bw-7ks.24 -b bw-7ks.24', 'Cut a worktree at bw-7ks.24'],
  ['git worktree list', 'Listed the worktrees'],
  ['git rev-parse HEAD', 'Resolved a revision'],
  ['git merge-base main HEAD', 'Found the common ancestor'],
  ['git ls-files', 'Listed the tracked files'],
  ['git clone https://github.com/a/b', 'Cloned github.com/a/b'],
  ['gh pr create --fill', 'Opened a pull request'],
  ['gh pr view 12', 'Read a pull request'],
  ['gh pr list', 'Listed the pull requests'],
  ['gh run list', 'Checked a workflow run'],
  ['gh api /repos/a/b', 'Asked the GitHub API'],

  // Building, testing, linting — both sides of this repo.
  ['cargo build --release', 'Built the Rust side'],
  ['cargo test', 'Ran the Rust tests'],
  ['cargo run', 'Ran the Rust binary'],
  ['cargo check', 'Checked the Rust side'],
  ['cargo clippy', 'Linted the Rust side'],
  ['cargo fmt', 'Formatted the Rust side'],
  ['rg -n "providerHoldsNow" workbench/src | head -20', 'Searched for providerHoldsNow in workbench/src'],
  ["sed -n '1,80p' src/workbench/live.ts", 'Read part of workbench/live.ts'],
  ['BEADS_E2E_URL=http://127.0.0.1:3008 node scripts/codex-ownership-smoke.mjs p s', 'Checked Codex ownership in the browser'],
  ['go test ./...', 'Ran the Go tests'],
  ['go build', 'Built the Go side'],
  ['make all', 'Built all'],
  ['pytest tests/', 'Ran the Python tests'],
  ['npm test', 'Ran the tests'],
  ['npm run build', 'Built the app'],
  ['npm run typecheck', 'Typechecked'],
  ['npm run dev', 'Started the app'],
  ['npm run lint', 'Linted'],
  ['npm run workbench', 'Started the workbench'],
  ['npm run some-custom-step', 'Ran the some-custom-step step'],
  ['npm install', 'Installed the dependencies'],
  ['npm ci', 'Installed the dependencies'],
  ['pnpm install', 'Installed the dependencies'],
  ['npx vitest run src/x.test.ts', 'Ran the tests'],
  ['npx tsc --noEmit', 'Typechecked'],
  ['npx playwright test', 'Ran the browser tests'],
  ['npx eslint .', 'Linted'],
  ['pip install -r requirements.txt', 'Installed the Python dependencies'],

  // Reading.
  ['cat src/workbench/fold.ts', 'Read workbench/fold.ts'],
  ['cat a.ts b.ts', 'Read 2 files'],
  ['head -20 src/x.ts', 'Read the top of src/x.ts'],
  ['tail -50 out.log', 'Read the end of out.log'],
  ['ls -la src/workbench', 'Listed src/workbench'],
  ['ls', 'Listed this folder'],
  ['wc -l src/x.ts', 'Counted src/x.ts'],
  ['stat src/x.ts', 'Checked src/x.ts'],
  ['du -sh .', 'Measured what is on disk'],
  ['df -h', 'Checked the free space'],
  ['diff a.txt b.txt', 'Compared a.txt and b.txt'],
  ['cmp a.txt b.txt', 'Compared a.txt and b.txt'],
  ['join users.txt roles.txt', 'Joined matching lines from files'],
  ['strings bin/x', 'Read the text out of bin/x'],
  ['nl -ba .codex/hooks.json', 'Read numbered .codex/hooks.json'],
  ['tail -n +1 output.log', 'Read the end of output.log'],
  ['sed -n "120,180p" src/x.ts', 'Read part of src/x.ts'],
  ['tsx scripts/check.ts', 'Ran check.ts'],
  ['machinery/board/run.py --help; machinery/board/move --help', 'Read the run options, then read the move options'],

  // Searching. The pattern is kept exactly as typed.
  ['grep -rn "toolTitle" workbench/src', 'Searched for toolTitle in workbench/src'],
  ['rg "whatItRan" src', 'Searched for whatItRan in src'],
  ['rg --files', 'Listed the files'],
  ['rg --files -g "*.ts" -g "!*.test.ts"', 'Listed the files matching *.ts, !*.test.ts'],
  ["/bin/bash -lc 'rg --files -g Cargo.toml'", 'Listed the files matching Cargo.toml'],
  ['grep -c foo a.txt b.txt c.txt', 'Searched for foo across 3 paths'],
  ['find . -name "*.test.ts"', 'Looked for *.test.ts'],
  ['find src -type f', 'Looked through src'],
  ['which node', 'Looked for node'],

  // Changing things on disk.
  ['sed -i "s/a/b/" src/x.ts', 'Rewrote src/x.ts'],
  ['mkdir -p out/x', 'Made out/x'],
  ['touch a.ts', 'Made a.ts'],
  ['cp a.ts b.ts', 'Copied a.ts to b.ts'],
  ['mv a.ts b/c.ts', 'Moved a.ts to b/c.ts'],
  ['chmod +x scripts/x.sh', 'Changed the permissions on scripts/x.sh'],
  ['tar -xzf x.tar.gz', 'Unpacked an archive'],
  ['unzip x.zip', 'Unpacked an archive'],

  // Running.
  ['node scripts/gate.mjs', 'Ran gate.mjs'],
  ['node -e "console.log(1)"', 'Ran Node: console.log(1)'],
  ['python3 scripts/x.py', 'Ran x.py'],
  ['python3 -c "print(1)"', 'Ran Python: print(1)'],
  ['bash scripts/e2e.sh', 'Ran e2e.sh'],

  // The network.
  ['curl -s https://api.github.com/repos/a/b', 'Fetched api.github.com/repos/a/b'],
  ['curl -sS http://localhost:3008/api/issues', 'Fetched localhost:3008/api/issues'],
  ['wget https://example.com/x.tar.gz', 'Downloaded example.com/x.tar.gz'],
  ['ssh box "uptime"', 'Ran a command on box'],
  ['rsync -a a/ b/', 'Copied files across'],

  // The machine.
  ['ps aux', 'Listed what is running'],
  ['pgrep -f workbench', 'Looked for workbench'],
  ['ss -ltnp', 'Checked what is listening'],
  ['lsof -i :3008', 'Checked what is listening'],
  ['systemctl restart nginx', 'Restarted nginx'],
  ['systemctl status beads-web', 'Checked beads-web'],
  ['systemctl --user stop beads-web', 'Stopped beads-web'],
  ['docker ps', 'Listed the containers'],
  ['docker logs api', 'Read a container log'],
  ['docker compose up -d', 'Started the containers'],
  ['docker build -t x .', 'Built an image'],
  ['kubectl get pods', 'Listed pods'],
  ['kubectl logs api', 'Read a pod log'],
  ['date', 'Checked the time'],

  // Data, and waiting.
  ['sqlite3 .beads/beads.db "select 1"', 'Queried beads.db'],
  ['psql -c "select 1"', 'Queried the database'],
  ['jq .name package.json', 'Picked fields out of some JSON'],
  ['sleep 5', 'Waited 5s'],
];

describe('one command, one sentence', () => {
  for (const [command, sentence] of RULES) {
    it(`says "${sentence}"`, () => {
      expect(said(command), command).toBe(sentence);
    });
  }

  it('speaks his words, not the wire\'s, in every one of them', () => {
    // A rule that leaked a flag or a subcommand into its sentence would print
    // `force_with_lease` or `runInBand` at him. Only the object a rule keeps
    // verbatim — a path, a card id, a pattern — may carry the shape.
    const wired = RULES.flatMap(([command, sentence]) => invented(sentence, command));
    expect(wired).toEqual([]);
  });

  it('files every sentence under a kind the look file can draw', () => {
    for (const [command] of RULES) {
      const ran = whatACommandDid(command);
      expect(RAN_KINDS, command).toContain(ran?.kind);
    }
  });
});

describe('a chain of commands', () => {
  it('names each thing it did, in the order it did them', () => {
    expect(said('npm run build && npm run typecheck && npm test'))
      .toBe('Built the app, then typechecked, then ran the tests');
  });

  it('names three and counts the rest, whatever the chain does after that', () => {
    // 42.1% of his commands run past two hundred characters. Writing every
    // stage of those out prints a title longer than the command it replaced.
    expect(said('npm run build && npm run typecheck && npm test && git add -A && git commit -m x'))
      .toBe('Built the app, then typechecked, then ran the tests, and 2 more');
  });

  it('reads a folder change as where it ran, never as a thing it did', () => {
    // A quarter of his commands open with one.
    expect(said('cd server && cargo test')).toBe('Ran the Rust tests in server');
    expect(said('cd /home/ahsan/dev/beads-web/worktrees/bw-7ks.24 && npm test'))
      .toBe('Ran the tests in bw-7ks.24');
  });

  it('says nothing about a folder change that went nowhere worth naming', () => {
    expect(said('cd . && npm test')).toBe('Ran the tests');
    expect(said('cd "$ROOT" && npm test')).toBe('Ran the tests');
  });

  it('does not count cutting the output down as a second thing done', () => {
    // `| head -20` is how a command is read, not another thing it did. Left
    // alone it printed "Read the history, and 1 more" at him.
    expect(said('git log --oneline | head -20')).toBe('Read the history');
    expect(said('npm test 2>&1 | tail -30')).toBe('Ran the tests');
    expect(said('cargo test 2>&1 | grep -E "^test result" | head -5')).toBe('Ran the Rust tests');
  });

  it('still names a trimmer when trimming is the only thing that happened', () => {
    expect(said('wc -l src/x.ts')).toBe('Counted src/x.ts');
    expect(said('grep -rn "foo" src')).toBe('Searched for foo in src');
  });

  it('keeps a pipe inside quotes out of the chain', () => {
    // Work reaches this repo's board as --do "what to do|how we know it is
    // done". Splitting on every `|` cut his own sentence in half and reported
    // the second half as another thing the command did.
    expect(said('machinery/board/job under bw-7ks.24 --do "close the card|the run is green"'))
      .toBe('Added the work items');
  });

  it('reads through a wrapper to the command underneath it', () => {
    expect(said('timeout 60 npm test')).toBe('Ran the tests');
    expect(said('sudo systemctl restart nginx')).toBe('Restarted nginx');
    expect(said('setsid nohup npm run dev')).toBe('Started the app');
    // His own proxy. 1,315 commands in the record go through it.
    expect(said('rtk git status')).toBe('Checked the working tree');
    expect(said('rtk proxy git status')).toBe('Checked the working tree');
  });

  it('reads past the settings in front of a command', () => {
    expect(said('BEADS_WEB_PORT=3011 npx next dev')).toBe('Started the app');
    expect(said('NODE_ENV=test CI=1 npm test')).toBe('Ran the tests');
  });
});

describe('a delete is never hidden', () => {
  it('reaches the sentence from the third link of a chain', () => {
    // The rule that is about safety rather than reading. A reader cannot tell
    // a wrong sentence from a right one, so the sentence must never be the
    // reason he did not know something was deleted.
    const ran = whatACommandDid('cd out && npm run build && rm -rf cache');
    expect(ran?.said).toBe('Built the app, then deleted cache in out');
    expect(ran?.grave).toBe(true);
    expect(ran?.kind).toBe('grave');
  });

  it('takes one of the three slots even when four harmless things came first', () => {
    // Left to the order it was written in, the `rm` fell off the end behind
    // "and 2 more" and the row read as an ordinary commit.
    const ran = whatACommandDid('git status && git add -A && git commit -m x && npm test && rm -rf dist');
    expect(ran?.said).toContain('deleted dist');
    expect(ran?.grave).toBe(true);
  });

  it('says so from inside a quoted script another command was handed', () => {
    // `sh -c '…'` is one word to anything reading the chain properly.
    const ran = whatACommandDid("bash -c 'cd /tmp && rm -rf x'");
    expect(ran?.said).toBe('Deleted x in tmp');
    expect(ran?.grave).toBe(true);
  });

  it('says so from behind an xargs', () => {
    const ran = whatACommandDid('pgrep -f node | xargs -r kill -9');
    expect(ran?.said).toBe('Looked for node, then killed a process');
    expect(ran?.grave).toBe(true);
  });

  it('says so from the body of a script', () => {
    const ran = whatACommandDid('if [ -f x ]; then rm -f x; fi');
    expect(ran?.said).toBe('Ran a shell script that deletes files');
    expect(ran?.grave).toBe(true);
  });

  it('says so when a link of the chain hands the delete to a shell in quotes', () => {
    // The delete sits straight after a double quote, which was not one of the
    // places the backstop read a command as starting. It read this as the
    // tests and a one-liner, and said nothing about the rm (bw-7ks.24.8).
    const ran = whatACommandDid('npm test && sh -c "rm -rf x"');
    expect(ran?.said).toBe('Ran the tests, then ran shell: rm -rf x, then deleted files');
    expect(ran?.grave).toBe(true);
  });

  it('says so when find is the one doing the deleting', () => {
    // Two shapes, and the second holds no `rm` anywhere in it at all. Both
    // read as looking around, which is the exact opposite of what they did.
    const byExec = whatACommandDid('find . -name "*.tmp" -exec rm {} \\;');
    expect(byExec?.said).toBe('Looked for *.tmp, then deleted files');
    expect(byExec?.grave).toBe(true);
    const byFlag = whatACommandDid('find . -name "*.log" -delete');
    expect(byFlag?.said).toBe('Deleted every *.log');
    expect(byFlag?.grave).toBe(true);
    expect(whatACommandDid('find . -delete')?.said).toBe('Deleted what it found');
    // And a find that deletes nothing is still just a look around.
    expect(whatACommandDid('find . -name "*.tmp"')?.grave).toBe(false);
  });

  it('says so when a script deletes by a flag rather than by a verb', () => {
    // The one the replay over his own record turned up: a three-line script
    // opening with a `find … -delete`. The chain reader catches a bare `find` by
    // its head, but a script never reaches the chain reader, and the backstop
    // scans for four VERBS — none of which that flag holds (bw-7ks.24.7).
    const script = [
      'find data/leaves -mindepth 1 -maxdepth 1 -type d -empty -delete',
      'echo "species left:"; ls -d data/leaves/*/ | wc -l',
      'echo; echo "each of the 17:"; for d in data/leaves/*/; do printf "  %-28s %s\\n" "$(basename $d)" "$(ls $d)"; done',
    ].join('\n');
    const ran = whatACommandDid(script);
    expect(ran?.said).toBe('Ran a shell script (3 lines) that deletes files');
    expect(ran?.grave).toBe(true);
  });

  it('leaves a flag alone that merely holds the word', () => {
    // `--delete-branch` throws no work away, and a sentence saying it did would
    // cry wolf on every merge he does.
    expect(whatACommandDid('gh pr merge 12 --squash --delete-branch')?.grave).toBe(false);
  });

  it('files every one of them under the grave kind, so the mark comes out red', () => {
    // The row takes its colour from the kind and reddens on `grave`. The two
    // must agree, or a chain that mostly ran tests draws an amber flask over
    // a deleted folder.
    for (const command of [
      'rm -rf out',
      'cd out && npm run build && rm -rf cache',
      'npm test && sh -c "rm -rf x"',
      'find . -name "*.log" -delete',
      'pgrep -f node | xargs -r kill -9',
      'if [ -f x ]; then rm -f x; fi',
      'git push --force-with-lease',
    ]) {
      const ran = whatACommandDid(command);
      expect(ran?.grave, command).toBe(true);
      expect(ran?.kind, command).toBe('grave');
    }
  });

  it('counts every way of throwing work away, not only rm', () => {
    for (const [command, sentence] of [
      ['rm -rf out', 'Deleted out'],
      ['rm a.txt', 'Deleted a.txt'],
      ['git rm -q src/x.ts', 'Deleted src/x.ts'],
      ['rmdir out', 'Deleted out'],
      ['kill -9 12345', 'Killed 12345'],
      ['pkill -f workbench', 'Killed workbench'],
      ['killall node', 'Killed node'],
      ['git push', 'Pushed'],
      ['git push --force-with-lease', 'Force-pushed'],
      ['git reset --hard', 'Threw away every change'],
      ['git clean -fd', 'Threw away untracked files'],
      ['docker rm -f api', 'Removed a container'],
      ['kubectl delete pod api', 'Deleted pod api'],
    ] as Array<[string, string]>) {
      const ran = whatACommandDid(command);
      expect(ran?.said, command).toBe(sentence);
      expect(ran?.grave, command).toBe(true);
    }
  });

  it('does not call a liveness check a kill', () => {
    // `kill -0` sends no signal at all; 41 of his commands use it to wait for
    // a process. Calling it a kill would cry wolf on every one of them.
    const ran = whatACommandDid('kill -0 12345');
    expect(ran?.said).toBe('Checked whether a process is still running');
    expect(ran?.grave).toBe(false);
  });

  it('leaves an ordinary command alone', () => {
    expect(whatACommandDid('npm test')?.grave).toBe(false);
    expect(whatACommandDid('git log --oneline')?.grave).toBe(false);
  });
});

describe('a script reads as a script', () => {
  it('says what it is written in and how long it is', () => {
    expect(said("python3 - <<'PY'\nimport os\nprint(os.getcwd())\nPY")).toBe('Ran a Python script (4 lines)');
    expect(said('for f in *.ts; do bd close $f; done')).toBe('Ran a shell script');
  });

  it('reads a here-document into a file as writing that file', () => {
    expect(said("cat > src/workbench/ran-look.ts <<'EOF'\nconst a = 1;\nEOF"))
      .toBe('Wrote workbench/ran-look.ts');
  });
});

describe('the commands no rule knows', () => {
  it('says nothing at all, so the row draws the command as it always did', () => {
    // The manager's own ruling, 2026-08-24: "for commands which don't fall into
    // our categorizer, we just show the raw commands as they are currently."
    expect(whatACommandDid('xyzzy --frobnicate')).toBeNull();
    expect(whatACommandDid('echo hi')).toBeNull();
    expect(whatACommandDid('')).toBeNull();
    expect(whatItRan('SomeToolThisBuildHasNeverMet', {})).toBeNull();
    expect(whatItRan('Bash', {})).toBeNull();
  });
});

describe('the tools that are not commands', () => {
  const CALLS: Array<[string, Record<string, unknown>, string]> = [
    ['Read', { file_path: '/a/src/workbench/fold.ts' }, 'Read workbench/fold.ts'],
    ['Write', { file_path: 'src/workbench/ran-look.ts' }, 'Wrote workbench/ran-look.ts'],
    ['Edit', { file_path: 'src/workbench/transcript-rows.tsx' }, 'Changed workbench/transcript-rows.tsx'],
    ['MultiEdit', { file_path: 'a/b.ts', edits: [1, 2, 3] }, 'Made 3 changes to a/b.ts'],
    ['NotebookRead', { notebook_path: 'a/b.ipynb' }, 'Read a/b.ipynb'],
    ['Grep', { pattern: 'toolTitle', path: 'workbench/src' }, 'Searched for toolTitle in workbench/src'],
    ['Glob', { pattern: '**/*.test.ts' }, 'Listed the files matching **/*.test.ts'],
    ['Agent', { subagent_type: 'scout', description: 'find the call sites' }, 'Sent off a scout to find the call sites'],
    ['SendMessage', { to: 'builder-1' }, 'Messaged builder-1'],
    ['Skill', { skill: 'report' }, 'Ran the report skill'],
    ['WebFetch', { url: 'https://docs.anthropic.com/en/api' }, 'Fetched docs.anthropic.com/en/api'],
    ['WebSearch', { query: 'vitest jsdom' }, 'Searched the web for vitest jsdom'],
    ['BashOutput', { bash_id: '1' }, 'Checked on a command left running'],
    ['Wait', {}, 'Waited for a running command'],
    ['ToolSearch', { query: 'select:Read' }, 'Looked for a tool it could use'],
    ['mcp__chrome-devtools__take_screenshot', {}, 'Looked at the screen'],
    ['mcp__chrome-devtools__navigate_page', {}, 'Opened a page'],
    ['mcp__codegraph__codegraph_explore', {}, 'Asked codegraph to explore'],
  ];

  for (const [name, input, sentence] of CALLS) {
    it(`says "${sentence}"`, () => {
      expect(whatItRan(name, input)?.said, name).toBe(sentence);
    });
  }

  it('never prints the kit\'s own name for a tool at him', () => {
    // `Grep`, `Glob`, `MultiEdit` and `BashOutput` are the kit's words for
    // these, and a row printing one is showing him the machine's name instead
    // of his own — the same fault machine-words.ts answers for the states.
    for (const name of KNOWN_TOOLS) {
      const ran = whatItRan(name, {});
      expect(ran, name).not.toBeNull();
      // Nothing invented, and a sentence even when the call carried no
      // argument at all — a record written by an older build still arrives
      // readable rather than as "Read " with nothing after it.
      expect(invented(ran!.said, ''), name).toEqual([]);
      expect(ran!.said, name).toMatch(/^[A-Z][a-z]+ \S/);
    }
  });

  it('stops a running command being read as an ordinary one', () => {
    expect(whatItRan('KillShell', {})?.grave).toBe(true);
    expect(whatItRan('TaskStop', {})?.grave).toBe(true);
  });

  it('puts every Claude and Codex agent operation in the agent category', () => {
    const claude = [
      'Agent', 'Task', 'SendMessage', 'ListAgents', 'TaskCreate', 'TaskGet',
      'TaskUpdate', 'TaskOutput', 'TaskList', 'TeamCreate',
    ];
    const codex = [
      'spawn_agent', 'followup_task', 'send_message', 'resume_agent',
      'list_agents', 'wait_agent',
    ];

    for (const name of [...claude, ...codex]) {
      expect(whatItRan(name, {})?.kind, name).toBe('agent');
    }
  });

  it('keeps agent operations that stop or delete work in the grave category', () => {
    for (const name of ['TaskStop', 'TeamDelete', 'interrupt_agent', 'close_agent']) {
      expect(whatItRan(name, {}), name).toMatchObject({ kind: 'grave', grave: true });
    }
  });
});

describe('both sides say it the same way', () => {
  /** What the sidecar puts on the wire, off the arguments it puts there too. */
  const bothSides = (name: string, input: Record<string, unknown>) => {
    const shown = trimInput(input);
    return { sidecar: toolTitle(name, shown), browser: whatItRan(name, shown)?.said ?? null };
  };

  it('gives the row the sentence and the feed the same one', () => {
    // The chat says "Ran the tests" while it is running them, asks permission
    // in those words, and settles onto a row that reads the same. Before this
    // the first two said `Bash npm test` and only the row spoke English.
    const both = bothSides('Bash', { command: 'npm test' });
    expect(both.sidecar).toBe('Ran the tests');
    expect(both.browser).toBe('Ran the tests');
  });

  it('leaves a command no rule knows in the raw form it has today', () => {
    const both = bothSides('Bash', { command: 'xyzzy --frobnicate' });
    expect(both.browser).toBeNull();
    expect(both.sidecar).toBe('Bash xyzzy --frobnicate');
  });

  it('agrees about a delete four thousand characters into a command', () => {
    // The one that is about safety. Every body on a row was cut at KEPT, and
    // the sentence is made of the same cut text — so a delete past it was
    // invisible to the row while the whole command sat in the record. 7 of the
    // 497 commands in his own log that run past KEPT are exactly this
    // (bw-7ks.24.6).
    const long = ['npm test', `echo ${'a'.repeat(5000)}`, 'rm -rf dist'].join(' && ');
    expect(long.length).toBeGreaterThan(KEPT);
    expect(long.length).toBeLessThan(COMMAND_KEPT);

    // What the old cap did to it: the delete is cut clean off the end.
    expect(whatACommandDid(cut(long, KEPT))?.grave).toBe(false);

    const both = bothSides('Bash', { command: long });
    expect(both.sidecar).toContain('deleted dist');
    expect(both.sidecar).toBe(both.browser);
  });

  it('still agrees about one longer than even a command is allowed', () => {
    // Past COMMAND_KEPT the cut bites again, and one command in 69,017 of his
    // is that long. Both sides then read the SAME cut text, so they say the
    // same thing about it — which is all that can be promised there.
    const huge = ['npm test', `echo ${'a'.repeat(COMMAND_KEPT)}`, 'rm -rf dist'].join(' && ');
    const both = bothSides('Bash', { command: huge });
    expect(both.sidecar).toBe(both.browser);
    expect(both.sidecar).toBe('Ran the tests, and 1 more');
  });

  it('cuts a command further than it cuts anything else on the same row', () => {
    const shown = trimInput({ command: 'a'.repeat(9000), content: 'b'.repeat(9000) });
    expect(String(shown.command)).toContain('a'.repeat(9000));
    expect(String(shown.content)).toContain('more characters');
  });
});

describe('what is still happening is said in the present', () => {
  it('turns every sentence the rules can produce, and leaves none in the past', () => {
    // The check that keeps the two lists together. A rule added tomorrow with a
    // verb nobody wrote down would print its past tense at a reader watching it
    // happen, under a spinner saying the opposite.
    const past: string[] = [];
    for (const [command, sentence] of RULES) {
      if (whileItRuns(sentence) === sentence) past.push(command);
    }
    for (const name of KNOWN_TOOLS) {
      const said = whatItRan(name, {})!.said;
      if (whileItRuns(said) === said) past.push(name);
    }
    expect(past).toEqual([]);
  });

  it('says it the way a reader watching it would', () => {
    expect(whileItRuns('Ran the tests')).toBe('Running the tests');
    expect(whileItRuns('Deleted dist')).toBe('Deleting dist');
    expect(whileItRuns('Wrote workbench/fold.ts')).toBe('Writing workbench/fold.ts');
    expect(whileItRuns('Threw away every change')).toBe('Throwing away every change');
    expect(whileItRuns('Force-pushed')).toBe('Force-pushing');
  });

  it('turns every stage of a chain, not just the first', () => {
    expect(whileItRuns('Built the app, then typechecked, then ran the tests'))
      .toBe('Building the app, then typechecking, then running the tests');
    // What was never a verb of ours is left exactly as it was.
    expect(whileItRuns('Built the app, then typechecked, and 2 more'))
      .toBe('Building the app, then typechecking, and 2 more');
  });

  it('leaves a sentence it has no verb for exactly as it found it', () => {
    expect(whileItRuns('Bash xyzzy --frobnicate')).toBe('Bash xyzzy --frobnicate');
    expect(whileItRuns('')).toBe('');
  });
});

describe('the card that asks permission', () => {
  it('shows the literal command and never the sentence', () => {
    // `rm -rf dist` and `rm -rf /` are one sentence and two very different
    // commands. On the one screen where the detail decides the answer, the
    // detail is what is drawn (bw-7ks.24.6).
    expect(rawTitle('Bash', { command: 'rm -rf dist' })).toBe('Bash rm -rf dist');
    expect(rawTitle('Read', { file_path: '/a/src/workbench/fold.ts' })).toBe('Read workbench/fold.ts');
    expect(rawTitle('Grep', { pattern: 'toolTitle' })).toBe('Grep toolTitle');
    expect(rawTitle('SomeTool', {})).toBe('SomeTool');
  });
});
