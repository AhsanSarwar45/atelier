import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const run = resolve('tests/.e2e-run-bw-9vv9-seven/fixture');
const binary = resolve('server/target/debug/atelier');
const env = { ...process.env, BEADS_ACTOR: 'fixture', ATELIER_DATA_DIR: join(run, 'app-data'), XDG_DATA_HOME: join(run, 'xdg') };
delete env.ATELIER_BYPASS; delete env.ATELIER_HOOKS;
rmSync(run, {recursive:true, force:true}); mkdirSync(run, {recursive:true});
const repo = join(run, 'repo'); mkdirSync(repo);
const call = (cwd, program, args, extra = {}) => execFileSync(program,args,{cwd,env:{...env,...extra},encoding:'utf8',timeout:120_000}).trim();
const git = (cwd,...args) => call(cwd,'git',args);
const bd = (...args) => call(repo,'bd',args);
const row = id => JSON.parse(bd('show',id,'--json'))[0];
const tool = (cwd,...args) => call(cwd,binary,['tool',...args]);
const refuse = (cwd,args,pattern,extra={}) => {
  const r = spawnSync(binary,['tool',...args],{cwd,env:{...env,...extra},encoding:'utf8',timeout:120_000});
  assert.notEqual(r.status,0,JSON.stringify(args)); assert.match(r.stdout+r.stderr,pattern);
};
git(repo,'init','-q','-b','main');git(repo,'config','user.name','fixture');git(repo,'config','user.email','fixture@example.invalid');
bd('init','--prefix','rc'); bd('config','set','status.custom','manager_review,in_review');
mkdirSync(join(repo,'.atelier'));
writeFileSync(join(repo,'.atelier/project.toml'),`schema_version = 1
[project]
display_name = "Recovery and cleanup proof"
use_beads = true
[beads]
issue_id_prefix = "rc"
[git]
completed_work_branch = "main"
agents_may_merge_completed_work = true
[[verification.commands]]
name = "Fixture check"
command = "test -f delivered.txt"
`);
writeFileSync(join(repo,'.gitignore'),'.beads/\nworktrees/\n');writeFileSync(join(repo,'delivered.txt'),'fixture');
git(repo,'add','.');git(repo,'commit','-qm','fixture baseline');
const make = (id,type='task',parent) => {bd('create','--id',id,'--title',id,'--type',type);if(parent)bd('update',id,'--parent',parent);};
const copy = id => { const p=join(repo,'worktrees',id);git(repo,'worktree','add','-b',id,p);return p; };

// Reproduce the installed cleanup refusal on real, isolated Git state.
make('rc-baseline'); const baseline=copy('rc-baseline'); bd('close','rc-baseline','--reason','fixture already on main');
writeFileSync(join(baseline,'leftover.txt'),'preserve me');
const installed = spawnSync('atelier',['tool','board/cleanup','rc-baseline','--force'],{cwd:repo,env,encoding:'utf8'});
writeFileSync(join(run,'installed-cleanup.json'),JSON.stringify({status:installed.status,stdout:installed.stdout,stderr:installed.stderr},null,2));
if(installed.status !== 0) console.log('REPRO installed cleanup --force refuses untracked fixture output');
if(existsSync(baseline)) {
  refuse(repo,['board/cleanup','rc-baseline'],/untracked files/);
  tool(repo,'board/cleanup','rc-baseline','--force');
  assert(!existsSync(baseline));
}

for(const provider of ['claude','codex']) {
  const id=`rc-${provider}`, who=`s-${provider}-recovery`, old=`s-${provider}-gone`;
  make(id,'epic');make(`${id}.1`,'task',id);make(`${id}.2`,'task',id);
  const work=copy(id);
  const event=command=>({tool_name:provider==='claude'?'Bash':'functions.exec_command', session_id:`${provider}-recovery`,cwd:provider==='claude'?work:repo,
    tool_input:provider==='claude'?{command,cwd:work}:{cmd:command,workdir:work}});
  // Claude's working directory is event-level; Codex supplies it with the tool.
  const hook=(name,data,allow=true)=>{
    const r=spawnSync(binary,['hook',name],{cwd:existsSync(work)?work:repo,env,input:JSON.stringify(data),encoding:'utf8',timeout:120_000});
    assert.equal(r.status,0,r.stderr);
    const out=name==='board-touch'?{}:(r.stdout.trim()?JSON.parse(r.stdout):{});
    if(allow) assert.notEqual(out.hookSpecificOutput?.permissionDecision,'deny',JSON.stringify(out));
    return out;
  };
  const execute=(command,where=work)=>{
    const data=event(command);data.cwd=where;
    if(provider==='codex')data.tool_input.workdir=where;
    hook('workflow-gate',data);
    data.tool_input=hook('board-actor',data).hookSpecificOutput?.updatedInput??data.tool_input;
    hook('board-status-gate',data);hook('board-merge-gate',data);
    return call(where,'sh',['-c',data.tool_input.command??data.tool_input.cmd]);
  };
  for(const child of [1,2])bd('update',`${id}.${child}`,'--status','in_progress','--assignee',old);
  assert.equal(row(`${id}.1`).lease_expires_at??null,null);
  const denied=hook('workflow-gate',event(`bd update ${id}.1 --claim`),false);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason,/board\/reclaim/);
  refuse(work,['board/reclaim',`${id}.1`,'--from',old,'--reason','account changed'],/--abandoned/,{BEADS_ACTOR:who});
  refuse(work,['board/reclaim',`${id}.1`,'--from','changed-owner','--abandoned','--reason','account changed'],/owner changed/,{BEADS_ACTOR:who});
  refuse(repo,['board/reclaim',`${id}.1`,'--from',old,'--abandoned','--reason','account changed'],/own job worktree/,{BEADS_ACTOR:who});
  for(const child of [1,2]) {
    execute(`'${binary}' tool board/reclaim ${id}.${child} --from ${old} --abandoned --reason 'old account session terminated'`);
    assert.equal(row(`${id}.${child}`).assignee,who);
    assert.ok(row(`${id}.${child}`).lease_expires_at);
    assert.match(execute(`'${binary}' tool board/reclaim ${id}.${child} --from ${old} --abandoned --reason 'retry interrupted recovery'`),/already owned/);
  }
  // Another genuinely live claimant must remain protected.
  make(`${id}-live`); call(repo,'bd',['update',`${id}-live`,'--claim'],{BEADS_ACTOR:old});
  bd('update',`${id}-live`,'--parent',id);
  refuse(work,['board/reclaim',`${id}-live`,'--from',old,'--abandoned','--reason','claimed abandoned'],/live lease/,{BEADS_ACTOR:who});
  assert.equal(row(`${id}-live`).assignee,old);
  bd('update',`${id}-live`,'--parent','');
  // Heartbeat two legacy owned cards that have no lease yet.
  for(const suffix of ['hb1','hb2']) {make(`${id}-${suffix}`);bd('update',`${id}-${suffix}`,'--status','in_progress','--assignee',who);}
  hook('board-touch',event('bd list'));
  for(const suffix of ['hb1','hb2'])assert.ok(row(`${id}-${suffix}`).lease_expires_at,'every owned card must be heartbeated');
  for(const child of [1,2]) {
    writeFileSync(join(work,`${provider}-child-${child}.txt`),'delivered');git(work,'add','.');git(work,'commit','-qm',`${id}.${child}: recovered work`);
    execute(`'${binary}' tool board/land ${id}.${child}`);assert.equal(row(`${id}.${child}`).status,'closed');
  }
  assert.equal(row(id).status,'closed');
  execute(`bd update ${id}.2 --append-notes 'Hook friction: fixture command; refusal; expected cleanup; workaround recorded after land'`);
  assert.match(row(`${id}.2`).notes,/Hook friction:/);
  assert.equal(row(`${id}.2`).status,'closed');
  // --force must never discard tracked modifications, including through the raw Git hook.
  writeFileSync(join(work,'delivered.txt'),'not landed');
  refuse(repo,['board/cleanup',id,'--force'],/tracked changes/);
  const raw=hook('workflow-gate',event(`git worktree remove --force '${work}'`),false);
  assert.equal(raw.hookSpecificOutput.permissionDecision,'deny');
  git(work,'restore','delivered.txt');
  const name=' leftover\nproof.txt';writeFileSync(join(work,name),'preserved evidence');
  refuse(repo,['board/cleanup',id],/untracked files/);
  const result=tool(repo,'board/cleanup',id,'--force');assert.match(result,/Preserved untracked files/);assert(!existsSync(work));
  const archives=join(repo,'.git','atelier-cleanup');
  const archive=join(archives,readdirSync(archives).find(n=>n.startsWith(`${id}-`)));
  assert.equal(call(repo,'tar',['-xOf',archive,name]),'preserved evidence');
  assert.equal(row(id).status,'closed');
  execute(`bd update ${id}.2 --append-notes 'Hook friction: recorded from main after cleanup'`,repo);
  assert.match(row(`${id}.2`).notes,/recorded from main after cleanup/);
  console.log(`PASS ${provider}: lease-less recovery, live-owner refusal, multi-card heartbeat, ordinary landing, post-land notes and archived cleanup`);
}
// Stale parent storage must not let unfinished children be discarded.
make('rc-unfinished','epic');make('rc-unfinished.1','task','rc-unfinished');copy('rc-unfinished');
bd('close','rc-unfinished','--force','--reason','fixture stale parent');
refuse(repo,['board/cleanup','rc-unfinished','--force'],/still has required work/);
console.log('PASS cleanup refuses a falsely closed parent with unfinished children');
console.log('Recovery and cleanup integration: all cases passed');
