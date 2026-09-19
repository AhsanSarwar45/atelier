import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';

const run = resolve('tests/.e2e-run-bw-9vv9/native');
const binary = resolve('server/target/debug/atelier');
const env = { ...process.env, BEADS_ACTOR: 'landing-test', XDG_DATA_HOME: join(run, 'xdg') };
delete env.ATELIER_BYPASS;
delete env.ATELIER_DATA_DIR;
const cmd = (cwd, program, args) => execFileSync(program, args, { cwd, env, encoding: 'utf8', timeout: 120_000 }).trim();
const git = (cwd, ...args) => cmd(cwd, 'git', args);
const bd = (cwd, ...args) => cmd(cwd, 'bd', args);
const tool = (cwd, ...args) => cmd(cwd, binary, ['tool', ...args]);
const row = (cwd, id) => JSON.parse(bd(cwd, 'show', id, '--json'))[0];
const fails = (cwd, args, pattern) => {
  const r = spawnSync(binary, ['tool', ...args], { cwd, env, encoding: 'utf8', timeout: 120_000 });
  assert.notEqual(r.status, 0, `unexpected success: ${args}`);
  assert.match(`${r.stdout}${r.stderr}`, pattern);
};
rmSync(run, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
mkdirSync(run, { recursive: true });
const repo = join(run, 'repo'); mkdirSync(repo);
git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'landing-test'); git(repo, 'config', 'user.email', 'test@example.invalid');
bd(repo, 'init', '--prefix', 'ld');
mkdirSync(join(repo, '.atelier'), { recursive: true });
writeFileSync(join(repo, '.atelier/project.toml'), `schema_version = 1
[project]
display_name = "Landing integration"
use_beads = true
[git]
completed_work_branch = "main"
agents_may_merge_completed_work = true
[beads]
issue_id_prefix = "ld"
[[verification.commands]]
name = "Delivery check"
command = "test -f delivered.txt"
paths = []
`);
writeFileSync(join(repo, '.gitignore'), '.beads/\nworktrees/\n');
git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'fixture base');
const installGuard = (interrupt = false) => {
  const hook = git(repo, 'rev-parse', '--git-path', 'hooks/reference-transaction');
  writeFileSync(hook, `#!/bin/sh
${interrupt ? '[ "$1" = committed ] && exit 0' : ''}
exec '${binary}' hook landing-gate "$@"
`);
  chmodSync(hook, 0o755);
};
installGuard();

const make = (id, type = 'task', parent) => {
  bd(repo, 'create', '--id', id, '--title', id, '--type', type);
  if (parent) bd(repo, 'update', id, '--parent', parent);
};
const copy = id => { const path = join(repo, 'worktrees', id); git(repo, 'worktree', 'add', '-b', id, path); return path; };
const commit = (path, id, file = 'delivered.txt') => { writeFileSync(join(path, file), id); git(path, 'add', file); git(path, 'commit', '-qm', `${id}: implement deliverable`); };

make('ld-one'); const one = copy('ld-one'); bd(one, 'update', 'ld-one', '--claim');
commit(one, 'ld-one', 'not-delivered.txt');
const raw = spawnSync('git', ['update-ref','refs/heads/main',git(one,'rev-parse','HEAD')], {cwd:repo,env,encoding:'utf8'});
assert.notEqual(raw.status, 0); assert.match(raw.stderr, /No prepared landing transaction/);
fails(one, ['board/land', 'ld-one'], /checks failed/);
assert.equal(row(repo, 'ld-one').status, 'in_progress');
assert.notEqual(git(one, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main'));
commit(one, 'ld-one');
tool(one, 'board/land', 'ld-one');
assert.equal(row(repo, 'ld-one').status, 'closed');
assert.equal(row(repo, 'ld-one').metadata.landed_commit, git(repo, 'rev-parse', 'main'));
assert.match(tool(one, 'board/land', 'ld-one'), /already Done/);
console.log('PASS standalone landing, failing checks, receipts and idempotent retry');

make('ld-job', 'epic'); make('ld-job.1', 'epic', 'ld-job'); make('ld-job.1.1', 'task', 'ld-job.1'); make('ld-job.2', 'task', 'ld-job');
const job = copy('ld-job'); bd(job, 'update', 'ld-job.1.1', '--claim'); commit(job, 'ld-job.1.1', 'nested.txt');
tool(job, 'board/land', 'ld-job.1.1');
assert.equal(row(repo, 'ld-job.1.1').status, 'closed'); assert.equal(row(repo, 'ld-job.1').status, 'closed'); assert.equal(row(repo, 'ld-job').status, 'in_progress');
bd(job, 'update', 'ld-job.2', '--claim'); commit(job, 'ld-job.2', 'last.txt'); tool(job, 'board/land', 'ld-job.2');
assert.equal(row(repo, 'ld-job').status, 'closed');
assert.equal(JSON.parse(bd(repo, 'list', '--parent', 'ld-job', '--status', 'all', '--json')).length, 2, 'no generated post-land checks or cleanup tickets');
console.log('PASS recursive completion and partial epic state without generated blockers');

make('ld-recover'); const recovery = copy('ld-recover'); bd(recovery, 'update', 'ld-recover', '--claim'); commit(recovery, 'ld-recover', 'recovery.txt');
const tip = git(recovery, 'rev-parse', 'HEAD'); const tree = git(recovery, 'rev-parse', 'HEAD^{tree}');
const journals = join(repo, '.git/atelier-landings'); mkdirSync(journals, { recursive: true });
writeFileSync(join(journals, 'interrupted.json'), JSON.stringify({version:1, branch:'main', tip, tree, actor:'landing-test', cards:['ld-recover'], complete:false}));
bd(recovery, 'update', 'ld-recover', '--set-metadata', `checks_tree=${tree}`, '--set-metadata', 'checks_passed=true');
bd(repo, 'merge-slot', 'acquire'); installGuard(true);
git(repo, 'merge', '--ff-only', 'ld-recover'); installGuard(); bd(repo, 'merge-slot', 'release');
assert.equal(row(repo, 'ld-recover').status, 'in_progress');
tool(repo, 'board/reconcile', '--apply'); assert.equal(row(repo, 'ld-recover').status, 'closed');
bd(repo, 'update', 'ld-recover', '--status', 'open'); tool(repo, 'board/reconcile', '--apply');
assert.equal(row(repo, 'ld-recover').status, 'open', 'an old receipt cannot close reopened work');
console.log('PASS recovery after merge and old-receipt protection on reopened work');

make('ld-review'); const review = copy('ld-review'); bd(review, 'update', 'ld-review', '--claim', '--set-metadata', 'review_required=true'); commit(review, 'ld-review', 'review.txt');
fails(review, ['board/land', 'ld-review'], /Review ld-review/);
assert.equal(row(repo, 'ld-review').status, 'in_progress');
bd(review, 'update', 'ld-review', '--set-metadata', `review_tree=${git(review, 'rev-parse', 'HEAD^{tree}')}`, '--set-metadata', 'review_passed=true');
tool(review, 'board/land', 'ld-review'); assert.equal(row(repo, 'ld-review').status, 'closed');
console.log('PASS required review precedes landing');

make('ld-stray'); make('ld-scope'); const scope = copy('ld-scope'); bd(scope, 'update', 'ld-scope', '--claim');
writeFileSync(join(scope, 'scope.txt'), 'implementation'); git(scope, 'add', 'scope.txt'); git(scope, 'commit', '-qm', 'ld-scope: implementation mentions ld-stray');
tool(scope, 'board/land', 'ld-scope'); assert.equal(row(repo, 'ld-stray').status, 'open');
console.log('PASS incidental commit mentions cannot close unrelated work');

make('ld-dependency'); make('ld-dependent'); const dependent = copy('ld-dependent');
bd(dependent, 'update', 'ld-dependent', '--claim');
bd(dependent, 'dep', 'add', 'ld-dependent', 'ld-dependency');
commit(dependent, 'ld-dependent', 'dependent.txt');
fails(dependent, ['board/land', 'ld-dependent'], /still requires ld-dependency/);
assert.equal(row(repo, 'ld-dependent').status, 'in_progress');
bd(dependent, 'dep', 'remove', 'ld-dependent', 'ld-dependency');
tool(dependent, 'board/land', 'ld-dependent');
console.log('PASS unresolved dependencies prevent landing until explicitly resolved');

tool(repo, 'board/cleanup', 'ld-job');
assert(!git(repo, 'worktree', 'list').includes('worktrees/ld-job'));
console.log('PASS cleanup requires no artificial commit');
console.log('Native landing integration: all cases passed');
