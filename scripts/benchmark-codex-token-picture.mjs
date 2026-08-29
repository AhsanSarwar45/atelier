#!/usr/bin/env node

import inspector from 'node:inspector';
import { performance } from 'node:perf_hooks';

import { codexTokenPictureStats } from '../workbench/src/codex-token-picture-stats.ts';

const EVENT_COUNT = 20_000;
const PASSES = 10;
const TRIALS = 9;
const events = [];
for (let index = 0; index < EVENT_COUNT / 5; index += 1) {
  events.push(
    { type: 'message.started', messageId: `m${index}`, role: index % 2 ? 'user' : 'assistant' },
    { type: 'tool.started' },
    { type: 'agent.started' },
    { type: 'note', kind: index % 3 ? 'other' : 'compact' },
    { type: 'message.completed', messageId: `m${index}` },
  );
}

function before() {
  return {
    turns: events.filter((event) => event.type === 'message.completed' && events.some(
      (start) => start.type === 'message.started' && start.messageId === event.messageId && start.role === 'assistant',
    )).length,
    toolCalls: events.filter((event) => event.type === 'tool.started').length,
    forgettings: events.filter((event) => event.type === 'note' && (event.kind === 'thread/compacted' || event.kind === 'compact')).length,
    helperCount: events.filter((event) => event.type === 'agent.started').length,
  };
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
    const order = index % 2 === 0
      ? [['before', before], ['after', () => codexTokenPictureStats(events)]]
      : [['after', () => codexTokenPictureStats(events)], ['before', before]];
    for (const [name, operation] of order) await trial(name, operation);
  }
} finally {
  session.disconnect();
}

const middle = Math.floor(TRIALS / 2);
const median = (values, field) => [...values].sort((left, right) => left[field] - right[field])[middle][field];
const beforeMedian = {
  ms: median(samples.before, 'ms'),
  allocatedBytes: median(samples.before, 'allocatedBytes'),
  result: samples.before[0].result,
};
const afterMedian = {
  ms: median(samples.after, 'ms'),
  allocatedBytes: median(samples.after, 'allocatedBytes'),
  result: samples.after[0].result,
};
if (JSON.stringify(beforeMedian.result) !== JSON.stringify(afterMedian.result)) {
  throw new Error('the implementations produced different counters');
}
console.log(JSON.stringify({
  workload: { events: EVENT_COUNT, passes: PASSES, trials: TRIALS },
  median: { before: beforeMedian, after: afterMedian },
  timeReductionPercent: (beforeMedian.ms - afterMedian.ms) / beforeMedian.ms * 100,
  allocationReductionPercent: (beforeMedian.allocatedBytes - afterMedian.allocatedBytes) / beforeMedian.allocatedBytes * 100,
  speedup: beforeMedian.ms / afterMedian.ms,
  samples,
}, null, 2));
