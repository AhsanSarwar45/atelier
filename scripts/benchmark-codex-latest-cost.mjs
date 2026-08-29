#!/usr/bin/env node

import inspector from 'node:inspector';
import { performance } from 'node:perf_hooks';

import { codexTokenPictureStats } from '../workbench/src/codex-token-picture-stats.ts';

const EVENT_COUNT = 200_000;
const PASSES = 10;
const TRIALS = 9;
const events = Array.from({ length: EVENT_COUNT }, (_, index) => {
  if (index % 10_000 === 0) {
    return index === 190_000
      ? { type: 'cost', cost: { kind: 'tokens', input: index, output: 1, total: index + 1 } }
      : { type: 'cost', cost: { kind: 'usd', usd: index } };
  }
  return { type: 'note', kind: 'ordinary' };
});

function currentCounters(history) {
  let forgettings = 0;
  for (const event of history) {
    if (event.type === 'note' && (event.kind === 'thread/compacted' || event.kind === 'compact')) forgettings += 1;
  }
  return forgettings;
}

function before() {
  const forgettings = currentCounters(events);
  const latestTokenCost = [...events].reverse().find(
    (event) => event.type === 'cost' && event.cost.kind === 'tokens',
  )?.cost ?? null;
  return { forgettings, latestTokenCost };
}

function after() {
  const stats = codexTokenPictureStats(events);
  return { forgettings: stats.forgettings, latestTokenCost: stats.latestTokenCost };
}

const session = new inspector.Session();
session.connect();
const post = (method, params = {}) => new Promise((resolve, reject) => {
  session.post(method, params, (error, result) => error ? reject(error) : resolve(result));
});
const allocatedBytes = (node) => node.selfSize + (node.children ?? []).reduce(
  (total, child) => total + allocatedBytes(child), 0,
);
const samples = { before: [], after: [] };

async function trial(name, operation) {
  globalThis.gc?.();
  await post('HeapProfiler.startSampling', {
    samplingInterval: 128,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const started = performance.now();
  let result;
  for (let pass = 0; pass < PASSES; pass += 1) result = operation();
  const ms = performance.now() - started;
  const { profile } = await post('HeapProfiler.stopSampling');
  samples[name].push({ ms, allocatedBytes: allocatedBytes(profile.head), result });
}

try {
  for (let index = 0; index < TRIALS; index += 1) {
    const order = index % 2 === 0 ? [['before', before], ['after', after]] : [['after', after], ['before', before]];
    for (const [name, operation] of order) await trial(name, operation);
  }
} finally {
  session.disconnect();
}

const middle = Math.floor(TRIALS / 2);
const median = (values, field) => [...values].sort((left, right) => left[field] - right[field])[middle][field];
const summary = (values) => ({
  ms: median(values, 'ms'),
  allocatedBytes: median(values, 'allocatedBytes'),
  result: values[0].result,
});
const beforeMedian = summary(samples.before);
const afterMedian = summary(samples.after);
if (JSON.stringify(beforeMedian.result) !== JSON.stringify(afterMedian.result)) {
  throw new Error('the implementations selected different costs or counters');
}
console.log(JSON.stringify({
  workload: { events: EVENT_COUNT, passes: PASSES, trials: TRIALS },
  median: { before: beforeMedian, after: afterMedian },
  timeReductionPercent: (beforeMedian.ms - afterMedian.ms) / beforeMedian.ms * 100,
  allocationReductionPercent: (beforeMedian.allocatedBytes - afterMedian.allocatedBytes) / beforeMedian.allocatedBytes * 100,
  speedup: beforeMedian.ms / afterMedian.ms,
  samples,
}, null, 2));
