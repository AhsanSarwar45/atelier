#!/usr/bin/env node

import { performance } from 'node:perf_hooks';

const BOARD_SIZE = 3168;
const JOBS = 50;
const PIECES = 12;
const PASSES = 100;
const TRIALS = 9;

const board = Array.from({ length: BOARD_SIZE }, (_, index) => ({
  id: `card-${index}`,
  status: index % 5 === 0 ? 'closed' : 'open',
}));
const jobs = Array.from({ length: JOBS }, (_, job) => ({
  children: Array.from({ length: PIECES }, (_, piece) =>
    `card-${(job * PIECES + piece) % BOARD_SIZE}`),
}));

function before() {
  for (const job of jobs) {
    job.children.map((id) => board.find((card) => card.id === id)).filter(Boolean);
    const wanted = new Set(job.children);
    board.filter((card) => wanted.has(card.id));
  }
}

function after() {
  const byId = new Map();
  const statusById = new Map();
  for (const card of board) {
    byId.set(card.id, card);
    statusById.set(card.id, card.status);
  }
  for (const job of jobs) {
    job.children.map((id) => byId.get(id)).filter(Boolean);
    job.children.map((id) => byId.get(id)).filter(Boolean);
  }
}

function trial(operation) {
  const started = performance.now();
  for (let pass = 0; pass < PASSES; pass += 1) operation();
  return performance.now() - started;
}

const samples = { before: [], after: [] };
for (let index = 0; index < TRIALS; index += 1) {
  const order = index % 2 === 0
    ? [['before', before], ['after', after]]
    : [['after', after], ['before', before]];
  for (const [name, operation] of order) samples[name].push(trial(operation));
}
for (const values of Object.values(samples)) values.sort((a, b) => a - b);
const median = (values) => values[(values.length - 1) / 2];
const beforeMs = median(samples.before);
const afterMs = median(samples.after);

console.log(JSON.stringify({
  workload: { board: BOARD_SIZE, jobs: JOBS, pieces_per_job: PIECES, passes: PASSES, trials: TRIALS },
  board_walks_per_pass: { before: JOBS * 2, after: 1 },
  median_ms: { before: beforeMs, after: afterMs },
  reduction_percent: (beforeMs - afterMs) / beforeMs * 100,
  speedup: beforeMs / afterMs,
  samples_ms: samples,
}, null, 2));
