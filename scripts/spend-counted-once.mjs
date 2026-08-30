/**
 * What a real record costs, counted both ways.
 *
 * The chat's spend used to be added up line by line, and the kit writes one
 * answer as several lines — its thinking, its words, each of its calls — every
 * one of them repeating that answer's usage. So the old figure billed a turn
 * once per block it happened to be made of. This prints both readings of a real
 * record so the gap is a number rather than an argument (bw-3ug7).
 *
 * Run it against any chat's own file:
 *
 *   node --experimental-strip-types scripts/spend-counted-once.mjs \
 *     ~/.claude/projects/<project>/<session>.jsonl
 *
 * The durable check is the unit suite (src/workbench/__tests__/token-picture.test.ts);
 * this is the one that can be pointed at the manager's own day.
 */
import { readFileSync } from 'node:fs';

import { splitOf, taskSpend } from '../src/workbench/token-picture.ts';

const path = process.argv[2];
if (!path) {
  console.error('usage: spend-counted-once.mjs <record.jsonl>');
  process.exit(2);
}

const lines = readFileSync(path, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null; // Half a line at the end of a file still being written.
    }
  })
  .filter((line) => line !== null);

/** The old arithmetic: every line that states a cost, added up. */
let overLines = 0;
for (const line of lines) {
  const usage = line?.message?.usage;
  if (usage) overLines += splitOf(usage).total;
}

const picture = taskSpend(lines);
const n = (x) => x.toLocaleString('en-US');

console.log(`record      ${path}`);
console.log(`lines       ${n(lines.length)}`);
console.log(`turns       ${n(picture.turns)}, ${n(picture.toolCalls)} tool calls, ${picture.forgettings} compactions`);
console.log(`line total  ${n(overLines)}`);
console.log(`task total  ${n(picture.total.total)}`);
console.log(
  `            input ${n(picture.total.input)} · cache writes ${n(picture.total.cacheWrite)} · cached input ${n(
    picture.total.cacheRead,
  )} · output ${n(picture.total.output)}`,
);
const high = overLines - picture.total.total;
console.log(`gap         ${n(high)} (${((high / picture.total.total) * 100).toFixed(1)}% high)`);
for (const model of picture.models) console.log(`  ${model.model.padEnd(28)} ${n(model.spend.total)}`);
