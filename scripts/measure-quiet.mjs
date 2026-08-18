/**
 * What keeping every quiet line actually costs the log.
 *
 * Not a check — the measurement behind docs/agent-workbench.md §8.2.5. It runs
 * two turns, each running one command, and tallies every event the chat would
 * store: how many, how many bytes, and how much of that is the lines nobody
 * reads unless they press Ctrl+O.
 *
 * It exists because that section once priced the wrong source entirely, from
 * the shape of the code rather than a run (bw-1u1.36). Run it again whenever
 * those numbers are questioned.
 *
 *   node scripts/measure-quiet.mjs
 *
 * Needs a signed-in `claude` and spends two short turns.
 */
import { ClaudeDriver } from '../workbench/src/drivers/claude.ts';

const drawn = [];
const driver = new ClaudeDriver();
await driver.start({ cwd: process.cwd(), permissionMode: 'bypassPermissions', emit: (e) => drawn.push(e) });
const settle = async (s = 240) => {
  const mark = drawn.length;
  for (let i = 0; i < s * 10; i += 1) {
    if (drawn.slice(mark).some((e) => e.type === 'session.state' && (e.state === 'idle' || e.state === 'errored'))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};
await driver.send({ text: 'Run exactly this in the shell and say nothing else: echo measuring', images: [] });
await settle();
await driver.send({ text: 'Run exactly this in the shell and say nothing else: echo measuring again', images: [] });
await settle();
await driver.close();

const tally = new Map();
for (const e of drawn) {
  const key = e.type === 'note' ? `note/${e.rank}/${e.kind}` : e.type;
  const row = tally.get(key) ?? { n: 0, bytes: 0 };
  row.n += 1;
  row.bytes += JSON.stringify(e).length;
  tally.set(key, row);
}
const rows = [...tally.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
let total = 0;
for (const [, r] of rows) total += r.bytes;
console.log(`two turns, each running one command. ${drawn.length} events, ${total} bytes of log.`);
for (const [k, r] of rows) console.log(`  ${String(r.n).padStart(3)}  ${String(r.bytes).padStart(7)}B  ${k}`);
const quiet = rows.filter(([k]) => k.startsWith('note/'));
const qn = quiet.reduce((a, [, r]) => a + r.n, 0);
const qb = quiet.reduce((a, [, r]) => a + r.bytes, 0);
console.log(`quiet lines: ${qn} of ${drawn.length} events (${Math.round((qn / drawn.length) * 100)}%), ${qb}B (${Math.round((qb / total) * 100)}% of the log)`);
