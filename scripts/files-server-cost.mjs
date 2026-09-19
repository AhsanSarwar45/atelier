/**
 * What the server costs the Files tab.
 *
 * Times the two calls opening a file makes — one level of the tree, and the
 * text of a file — against a RUNNING instance, and prints the spread over
 * repeated runs together with the bytes each answer carries.
 *
 *   BEADS_E2E_URL=http://127.0.0.1:3411 node scripts/files-server-cost.mjs <checkout>
 */
const APP = process.env.BEADS_E2E_URL ?? 'http://127.0.0.1:3411';
const root = process.argv[2] ?? process.cwd();
const RUNS = Number(process.env.RUNS ?? 12);

async function time(url) {
  const at = performance.now();
  const answer = await fetch(url);
  const body = await answer.arrayBuffer();
  return { ms: performance.now() - at, bytes: body.byteLength, status: answer.status, body };
}

function spread(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { min: sorted[0], p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

async function bench(label, url) {
  const first = await time(url);
  const rest = [];
  for (let i = 0; i < RUNS; i += 1) rest.push((await time(url)).ms);
  const s = spread(rest);
  console.log(
    `${label.padEnd(46)} cold ${first.ms.toFixed(1).padStart(8)}ms  ` +
    `warm p50 ${s.p50.toFixed(1).padStart(7)}ms  p95 ${s.p95.toFixed(1).padStart(7)}ms  ` +
    `max ${s.max.toFixed(1).padStart(7)}ms  ${(first.bytes / 1024).toFixed(1).padStart(8)}KB  [${first.status}]`,
  );
  return first;
}

const tree = (dir) => `${APP}/api/fs/tree?dir=${encodeURIComponent(dir)}`;
const read = (path) => `${APP}/api/fs/read?path=${encodeURIComponent(path)}`;

console.log(`root ${root}\nruns ${RUNS} warm per call\n`);

await bench('tree: checkout root', tree(root));
for (const dir of (process.env.DIRS ?? 'src,src/workbench,server/src,node_modules').split(',')) {
  await bench(`tree: ${dir}`, tree(`${root}/${dir}`));
}
for (const file of (process.env.FILES ?? '').split(',').filter(Boolean)) {
  await bench(`read: ${file}`, read(`${root}/${file}`));
}
