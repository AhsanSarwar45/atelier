#!/usr/bin/env node

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const binary = process.argv[2];
const label = process.argv[3];
const samples = Number(process.argv[4] || 9);
if (!binary || !label || !Number.isInteger(samples) || samples < 5) {
  console.error('usage: benchmark-board-cache-memory.mjs BINARY LABEL SAMPLES>=5');
  process.exit(2);
}

const BOARD_COUNT = 8;
const CARD_COUNT = 3168;
const CACHED_READS = 8;

async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function memory(pid) {
  const status = await readFile(`/proc/${pid}/status`, 'utf8');
  const kib = (name) => Number(status.match(new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm'))?.[1] || 0);
  return { rss: kib('VmRSS'), peak: kib('VmHWM') };
}

function card(board, index) {
  const id = `board-${board}-${index}`;
  const words = `${id} ` + 'memory benchmark card '.repeat(6);
  return {
    id,
    title: words,
    description: `${words}\n`.repeat(7),
    status: index % 5 === 0 ? 'closed' : 'open',
    priority: index % 5,
    issue_type: index % 3 === 0 ? 'bug' : 'task',
    owner: 'benchmark@example.invalid',
    created_at: '2026-08-20T09:00:00Z',
    updated_at: '2026-08-29T09:00:00Z',
    notes: `${words}\n`.repeat(3),
    labels: ['area:server', 'kind:benchmark'],
    dependencies: index > 1 ? [`board-${board}-${index - 1}`] : [],
    comments: [{ id: `${index}`, issue_id: id, author: 'bench', text: words, created_at: '2026-08-29T09:00:00Z' }],
  };
}

async function fixtures(root) {
  const boards = [];
  for (let board = 0; board < BOARD_COUNT; board += 1) {
    const project = join(root, `project-${board}`);
    const beads = join(project, '.beads');
    await mkdir(beads, { recursive: true });
    const lines = Array.from({ length: CARD_COUNT }, (_, index) => JSON.stringify(card(board, index))).join('\n');
    await writeFile(join(beads, 'issues.jsonl'), `${lines}\n`);
    boards.push(project);
  }
  return boards;
}

async function waitUntilReady(port, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('server did not become ready');
}

async function stop(child) {
  if (child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error.code === 'ESRCH') return;
    throw error;
  }
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

async function oneSample(root, boards, sample) {
  const port = await freePort();
  const workbenchPort = await freePort();
  const data = join(root, `data-${sample}`);
  await mkdir(data, { recursive: true });
  const child = spawn(binary, [], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ATELIER_DATA_DIR: data,
      ATELIER_HOST: '127.0.0.1',
      ATELIER_PORT: String(port),
      BEADS_WEB_PORT: String(port),
      BEADS_WORKBENCH_PORT: String(workbenchPort),
      PORT: String(port),
      RUST_LOG: 'error',
      PATH: '/usr/bin:/bin',
    },
  });
  try {
    await waitUntilReady(port, child);
    const idle = await memory(child.pid);
    for (const board of boards) {
      const response = await fetch(`http://127.0.0.1:${port}/api/beads?path=${encodeURIComponent(board)}`);
      if (!response.ok) throw new Error(`board request failed: ${response.status} ${await response.text()}`);
      await response.arrayBuffer();
    }
    const held = boards.at(-1);
    for (let read = 0; read < CACHED_READS; read += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/api/beads?path=${encodeURIComponent(held)}`);
      if (!response.ok) throw new Error(`cached request failed: ${response.status}`);
      await response.arrayBuffer();
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    const loaded = await memory(child.pid);
    return {
      sample: sample + 1,
      idle_mib: idle.rss / 1024,
      retained_mib: loaded.rss / 1024,
      workload_mib: (loaded.rss - idle.rss) / 1024,
      peak_mib: loaded.peak / 1024,
      peak_over_idle_mib: (loaded.peak - idle.rss) / 1024,
    };
  } finally {
    await stop(child);
  }
}

const fixtureParent = process.env.BOARD_MEMORY_FIXTURE_ROOT || tmpdir();
await mkdir(fixtureParent, { recursive: true });
const root = await mkdtemp(join(fixtureParent, `atelier-memory-${label}-`));
try {
  const boards = await fixtures(root);
  const results = [];
  for (let sample = 0; sample < samples; sample += 1) results.push(await oneSample(root, boards, sample));
  console.log(JSON.stringify({ label, board_count: BOARD_COUNT, cards_per_board: CARD_COUNT, cached_reads: CACHED_READS, samples: results }));
} finally {
  await rm(root, { recursive: true, force: true });
}
