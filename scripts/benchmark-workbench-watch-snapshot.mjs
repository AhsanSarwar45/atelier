#!/usr/bin/env node

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { Store } from '../workbench/src/store.ts';

const SESSION_COUNT = 152;
const LINK_COUNT = 877;
const TRIALS = 9;
const root = mkdtempSync(join(tmpdir(), 'watch-snapshot-benchmark-'));
const store = new Store(join(root, 'workbench.db'));
const at = '2026-08-29T00:00:00Z';

try {
  for (let index = 0; index < SESSION_COUNT; index += 1) {
    store.createSession({
      id: `s-${index}`, brand: 'codex', externalId: null, projectId: 'p', projectPath: '/p',
      cwd: '/p', model: null, permissionMode: 'default', effort: null, title: `Session ${index}`,
      state: 'dormant', createdAt: at, lastActiveAt: at, origin: 'app',
    });
  }
  for (let index = 0; index < LINK_COUNT; index += 1) {
    store.rememberBeadLink(`s-${index % SESSION_COUNT}`, `bw-${index}`, 'benchmark');
  }
  const internal = store;
  const prepare = internal.db.prepare.bind(internal.db);
  let queries = 0;
  internal.db.prepare = (sql) => {
    if (String(sql).includes('FROM bead_link')) queries += 1;
    return prepare(sql);
  };
  const ids = store.listSessions().map((session) => session.id);
  const samples = { before: [], after: [] };
  const run = (name, operation) => {
    queries = 0;
    const started = performance.now();
    operation();
    samples[name].push({ ms: performance.now() - started, queries });
  };
  for (let trial = 0; trial < TRIALS; trial += 1) {
    const order = trial % 2 === 0
      ? [['before', () => ids.map((id) => store.beadsForSession(id))], ['after', () => store.beadsForSessions(ids)]]
      : [['after', () => store.beadsForSessions(ids)], ['before', () => ids.map((id) => store.beadsForSession(id))]];
    for (const [name, operation] of order) run(name, operation);
  }
  for (const values of Object.values(samples)) values.sort((a, b) => a.ms - b.ms);
  const before = samples.before[4];
  const after = samples.after[4];
  console.log(JSON.stringify({
    workload: { sessions: SESSION_COUNT, links: LINK_COUNT, trials: TRIALS },
    median: { before, after },
    time_reduction_percent: (before.ms - after.ms) / before.ms * 100,
    speedup: before.ms / after.ms,
    samples,
  }, null, 2));
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}
