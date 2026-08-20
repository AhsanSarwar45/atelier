/**
 * What it costs to open a chat another program is driving — twice.
 *
 * Such a chat is never finished being read: the other program is still writing
 * to its record. So it fell through every "already read" test and was read from
 * its first byte on every single click — the whole record parsed, the drawing
 * thrown away and the conversation published again. Its follower already stops
 * at a byte; that byte is now remembered, and the second open carries on from
 * it (bw-uiyz.19).
 *
 * Self-contained: it stands up a sidecar of its own against a temporary config
 * directory and a temporary store, fabricates a long record, and makes it live
 * by writing the marker Claude Code writes for a running process — naming a
 * real child process of this script, so the sidecar's own liveness test passes
 * for the honest reason.
 *
 *   node scripts/live-chat-open.mjs [lines]
 *
 * Both clicks must come back under 300ms. Before the change the second cost
 * seconds and grew with the record; after it, it does not grow at all.
 */
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const LINES = Number(process.argv[2] ?? 4_000);
const BUDGET_MS = 300;
const PORT = 3061;

const root = mkdtempSync(join(tmpdir(), 'live-chat-open-'));
const config = join(root, 'claude');
const project = join(root, 'project');
const sessionId = randomUUID();
// The kit names a project's folder after its working directory, every
// character outside a word turned into a dash, and its own reader finds a
// record only there.
const folder = project.replace(/[^a-zA-Z0-9]/g, '-');
mkdirSync(join(config, 'sessions'), { recursive: true });
mkdirSync(join(config, 'projects', folder), { recursive: true });
mkdirSync(project, { recursive: true });

/** A record long enough that reading the whole of it is felt. */
const record = join(config, 'projects', folder, `${sessionId}.jsonl`);
const said = [];
for (let i = 0; i < LINES; i++) {
  const role = i % 2 === 0 ? 'user' : 'assistant';
  said.push(
    JSON.stringify({
      type: role,
      uuid: `line-${i}`,
      parentUuid: i === 0 ? null : `line-${i - 1}`,
      sessionId,
      cwd: project,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i % 60)).toISOString(),
      message: { role, content: [{ type: 'text', text: `line ${i} ${'x'.repeat(400)}` }] },
    }),
  );
}
writeFileSync(record, said.join('\n') + '\n');

/** A real process for the marker to name, so "is it alive" is answered honestly. */
const held = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
const stat = readFileSync(`/proc/${held.pid}/stat`, 'utf8');
const procStart = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
writeFileSync(
  join(config, 'sessions', `${held.pid}.json`),
  JSON.stringify({
    sessionId,
    pid: held.pid,
    cwd: project,
    startedAt: Date.now(),
    procStart,
    entrypoint: 'cli',
    kind: 'claude',
  }),
);

const sidecar = spawn(
  process.execPath,
  ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'workbench/src/server.ts'],
  {
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: config,
      BEADS_WORKBENCH_PORT: String(PORT),
      BEADS_WORKBENCH_DB: join(root, 'workbench.db'),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  },
);

function stop(code) {
  sidecar.kill('SIGKILL');
  held.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
  process.exit(code);
}

await new Promise((up, down) => {
  const bell = setTimeout(() => down(new Error('the sidecar never came up')), 30_000);
  sidecar.stdout.on('data', (chunk) => {
    if (String(chunk).includes('listening')) {
      clearTimeout(bell);
      up();
    }
  });
});

/** One click on the chat, from the moment it is asked for to the moment it answers. */
async function click() {
  const started = Date.now();
  const answer = await fetch(`http://127.0.0.1:${PORT}/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'session.open',
      externalId: sessionId,
      brand: 'claude',
      projectId: 'p',
      projectPath: project,
    }),
  });
  const body = await answer.json();
  if (answer.status !== 200) throw new Error(`open refused: ${answer.status} ${JSON.stringify(body)}`);
  return Date.now() - started;
}

/** How many rows the chat has drawn: a click that drew none proves nothing. */
function rowsDrawn() {
  const db = new DatabaseSync(join(root, 'workbench.db'), { readOnly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM message').get().n;
  } finally {
    db.close();
  }
}

try {
  const first = await click();
  // Long enough for the follower to take a beat and settle on a byte, which is
  // what the second click carries on from.
  await new Promise((wake) => setTimeout(wake, 2_500));
  const second = await click();

  const drawn = rowsDrawn();
  console.log(`a live chat of ${LINES} lines (${(said.join('\n').length / 1e6).toFixed(1)} MB), ${drawn} rows drawn`);
  console.log(`  first click   ${first}ms`);
  console.log(`  second click  ${second}ms`);
  if (drawn === 0) {
    console.log('NOTHING was drawn: the record was not read at all, so these numbers say nothing');
    stop(1);
  }
  const over = [first, second].filter((ms) => ms > BUDGET_MS);
  if (over.length > 0) {
    console.log(`OVER the ${BUDGET_MS}ms budget: ${over.join('ms, ')}ms`);
    stop(1);
  }
  console.log(`both under the ${BUDGET_MS}ms budget`);
  stop(0);
} catch (err) {
  console.error(String(err));
  stop(1);
}
