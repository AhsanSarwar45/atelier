#!/usr/bin/env node
// Measures one built `atelier` binary end to end, the way a person meets it.
//
// It starts the binary against a private copy of real data, opens the screens
// in Chromium, and reports what each one costs: bytes on the wire by kind, the
// number of requests, and how long until the screen is drawn. Every screen is
// loaded with an empty cache twice over — once as the host (no throttling) and
// once as a device on Wi-Fi — so the network cost is seen where it is paid. It
// then leaves the board and a long chat open and records the server's memory
// and CPU over an idle minute.
//
//   node scripts/perf/measure.mjs --binary server/target/release/atelier \
//     --data tests/.perf-run-data --label after [--runs 3] [--idle 60]
//
// `--data` holds `workbench.db` (+ `-wal`/`-shm`) and a `beads-web/` project
// with `.beads/issues.jsonl`; the database is copied (reflink) per run so runs
// start equal. Nothing outside that folder and two probed ports is touched.

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, word, i, all) => {
    if (word.startsWith('--')) pairs.push([word.slice(2), all[i + 1]]);
    return pairs;
  }, []),
);
const binary = resolve(args.binary ?? 'server/target/release/atelier');
const data = resolve(args.data ?? 'tests/.perf-run-data');
const label = args.label ?? 'run';
const runs = Number(args.runs ?? 3);
const idleSeconds = Number(args.idle ?? 60);
const chatId = args.chat ?? '8bfd27db-d502-463e-8181-7817ab60718a';
const only = args.screens ? new Set(args.screens.split(',')) : null;
// Experiments on an unchanged binary: `--thp-off 1` starts it with transparent
// huge pages disabled for the process (prctl PR_SET_THP_DISABLE, inherited
// across exec); `--env K=V,K2=V2` adds environment such as allocator tunables.
const thpOff = Boolean(args['thp-off']);
const extraEnv = Object.fromEntries((args.env ?? '').split(',').filter(Boolean).map((pair) => pair.split('=')));

// A device on the network reaches the app over plain http at a LAN address,
// where browsers offer only gzip and deflate; loopback is a secure context and
// is also offered br and zstd. The wifi profile says what the device would.
const PROFILES = {
  host: { conditions: null, acceptEncoding: null },
  wifi: {
    conditions: { offline: false, latency: 30, downloadThroughput: (20 * 1024 * 1024) / 8, uploadThroughput: (10 * 1024 * 1024) / 8 },
    acceptEncoding: 'gzip, deflate',
  },
};

async function freePort() {
  return new Promise((ok, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

function tree(pid) {
  let kids = [];
  try {
    kids = readdirSync(`/proc/${pid}/task`).flatMap((task) =>
      readFileSync(`/proc/${pid}/task/${task}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number));
  } catch {}
  return [pid, ...kids.flatMap(tree)];
}

function memory(pid) {
  const kib = (p, name) => {
    try {
      return Number(readFileSync(`/proc/${p}/status`, 'utf8').match(new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm'))?.[1] ?? 0);
    } catch {
      return 0;
    }
  };
  const mib = (k) => +(k / 1024).toFixed(1);
  const rest = tree(pid).slice(1);
  return {
    rss_mib: mib(kib(pid, 'VmRSS')),
    peak_mib: mib(kib(pid, 'VmHWM')),
    children: rest.length,
    children_rss_mib: mib(rest.reduce((sum, p) => sum + kib(p, 'VmRSS'), 0)),
  };
}

function cpuTicks(pid) {
  return tree(pid).reduce((sum, p) => {
    try {
      const fields = readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1].split(' ');
      return sum + Number(fields[11]) + Number(fields[12]);
    } catch {
      return sum;
    }
  }, 0);
}

const median = (values) => {
  const sorted = values.filter((v) => v != null).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

async function start() {
  const port = await freePort();
  const workbenchPort = await freePort();
  const run = join(data, `run-${label}`);
  rmSync(run, { recursive: true, force: true });
  mkdirSync(join(run, 'data'), { recursive: true });
  for (const name of readdirSync(data).filter((n) => n.startsWith('workbench.db'))) {
    execFileSync('cp', ['--reflink=auto', join(data, name), join(run, 'data', name)]);
  }
  for (const dir of ['xdg', 'claude', 'codex', 'media']) mkdirSync(join(run, dir), { recursive: true });
  const launch = thpOff
    ? ['/usr/bin/python3', ['-c', 'import ctypes,os,sys; assert ctypes.CDLL(None).prctl(41,1,0,0,0)==0; os.execv(sys.argv[1], sys.argv[1:])', binary, 'run', '--no-browser']]
    : [binary, ['run', '--no-browser']];
  const child = spawn(launch[0], launch[1], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      HOME: process.env.HOME,
      // `bin/bd` answers the board's reads from the fixture's issues.jsonl, so
      // no real tracker or database is ever reached.
      PATH: `${join(data, 'bin')}:/usr/bin:/bin`,
      ATELIER_DATA_DIR: join(run, 'data'),
      ATELIER_PRESENTATION_MEDIA_DIR: join(run, 'media'),
      ATELIER_PRESENTATION_EPHEMERAL: '1',
      XDG_DATA_HOME: join(run, 'xdg'),
      CLAUDE_CONFIG_DIR: join(run, 'claude'),
      CODEX_HOME: join(run, 'codex'),
      HISTFILE: join(run, 'history'),
      ATELIER_HOST: '127.0.0.1',
      BEADS_WEB_HOST: '127.0.0.1',
      ATELIER_PORT: String(port),
      BEADS_WEB_PORT: String(port),
      BEADS_WORKBENCH_PORT: String(workbenchPort),
      RUST_LOG: 'error',
      ...extraEnv,
    },
  });
  const base = `http://127.0.0.1:${port}`;
  const began = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {}
    if (Date.now() - began > 180_000) throw new Error('server never became ready');
    await new Promise((r) => setTimeout(r, 100));
  }
  return { child, base, run, ready_ms: Date.now() - began, ports: [port, workbenchPort] };
}

async function stop(child) {
  if (child.exitCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 3000))]);
  if (child.exitCode === null) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
}

/** Loads one screen in a fresh context and returns what it cost. */
async function load(browser, base, screen, profile) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  if (profile.conditions) await cdp.send('Network.emulateNetworkConditions', profile.conditions);
  if (profile.acceptEncoding) await cdp.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Encoding': profile.acceptEncoding } });
  const seen = new Map();
  const bytes = {};
  const byEncoding = {};
  let requests = 0;
  let decoded = 0;
  let acceptEncoding = null;
  cdp.on('Network.requestWillBeSentExtraInfo', (e) => {
    const h = Object.fromEntries(Object.entries(e.headers).map(([k, v]) => [k.toLowerCase(), v]));
    acceptEncoding ??= h['accept-encoding'] ?? null;
  });
  cdp.on('Network.responseReceived', (e) => {
    const h = Object.fromEntries(Object.entries(e.response.headers).map(([k, v]) => [k.toLowerCase(), v]));
    seen.set(e.requestId, { kind: e.type, encoding: h['content-encoding'] ?? 'identity' });
  });
  cdp.on('Network.dataReceived', (e) => { decoded += e.dataLength; });
  cdp.on('Network.loadingFinished', (e) => {
    const { kind, encoding } = seen.get(e.requestId) ?? { kind: 'Other', encoding: 'identity' };
    requests += 1;
    bytes[kind] = (bytes[kind] ?? 0) + e.encodedDataLength;
    byEncoding[encoding] = (byEncoding[encoding] ?? 0) + 1;
  });
  const began = Date.now();
  await page.goto(base + screen.path, { waitUntil: 'commit' });
  let drawn = null;
  let untilDrawn = null;
  try {
    await page.locator(screen.drawn).first().waitFor({ timeout: 90_000 });
    drawn = Date.now() - began;
    untilDrawn = Object.values(bytes).reduce((a, b) => a + b, 0);
  } catch {}
  // What the screen fetches right after it draws is part of its cost.
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  if (args.shot) await page.screenshot({ path: join(resolve(args.shot), `${label}-${screen.name}-${Date.now()}.png`) }).catch(() => {});
  const heap = await cdp.send('Runtime.getHeapUsage').catch(() => null);
  const total = Object.values(bytes).reduce((a, b) => a + b, 0);
  await context.close();
  const kib = (n) => +(n / 1024).toFixed(1);
  return {
    drawn_ms: drawn,
    requests,
    transferred_until_drawn_kib: untilDrawn == null ? null : kib(untilDrawn),
    transferred_kib: kib(total),
    decoded_kib: kib(decoded),
    by_kind_kib: Object.fromEntries(Object.entries(bytes).map(([k, v]) => [k, kib(v)])),
    responses_by_encoding: byEncoding,
    accept_encoding: acceptEncoding,
    js_heap_mib: heap ? +(heap.usedSize / 1048576).toFixed(1) : null,
  };
}

const { child, base, run, ready_ms, ports } = await start();
// Stopped from outside, the server this run started goes with it.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    process.exit(130);
  });
}
const report = { label, binary, thp_off: thpOff, env: extraEnv, binary_mib: +(statSync(binary).size / 1048576).toFixed(2), ready_ms, memory: {} };
try {
  report.memory.started = memory(child.pid);
  const made = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'beads-web', path: join(data, 'beads-web') }),
  });
  if (made.status !== 201) throw new Error(`project: ${made.status} ${await made.text()}`);
  const project = await made.json();
  {
    const began = Date.now();
    const board = await fetch(`${base}/api/beads?path=${encodeURIComponent(project.path)}`, { headers: { 'accept-encoding': 'gzip' } });
    const body = await board.arrayBuffer();
    report.board_api_cold = { status: board.status, ms: Date.now() - began, content_encoding: board.headers.get('content-encoding'), decoded_kib: +(body.byteLength / 1024).toFixed(1) };
  }

  const screens = [
    { name: 'home', path: '/', drawn: '[aria-label="Open Beads Web"]' },
    { name: 'board', path: `/project?id=${project.id}&tab=board`, drawn: '[aria-label^="Select card:"], [aria-label^="Select epic:"]' },
    { name: 'chat', path: `/project?id=${project.id}&tab=chat&chat=${chatId}`, drawn: '[data-testid="transcript-rows"] > *' },
    { name: 'settings', path: '/settings', drawn: 'h1, h2, [role="tablist"]' },
  ].filter((s) => !only || only.has(s.name));
  const browser = await chromium.launch();
  report.screens = {};
  for (const [profileName, profile] of Object.entries(PROFILES)) {
    for (const screen of screens) {
      const samples = [];
      for (let i = 0; i < runs; i += 1) samples.push(await load(browser, base, screen, profile));
      const { drawn_ms, ...last } = samples.at(-1);
      const key = `${screen.name}@${profileName}`;
      report.screens[key] = { drawn_ms_median: median(samples.map((s) => s.drawn_ms)), drawn_ms_all: samples.map((s) => s.drawn_ms), ...last };
      report.memory[`after_${key}`] = memory(child.pid);
      console.error(label, key, JSON.stringify(report.screens[key]), JSON.stringify(report.memory[`after_${key}`]));
    }
  }
  report.memory.after_screens = memory(child.pid);

  if (idleSeconds > 0) {
    // Idle: the board and the long chat left open, nobody touching anything.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const open = [];
    for (const screen of screens.filter((s) => s.name === 'board' || s.name === 'chat')) {
      const page = await context.newPage();
      await page.goto(base + screen.path);
      await page.locator(screen.drawn).first().waitFor({ timeout: 90_000 }).catch(() => {});
      open.push(page);
    }
    await new Promise((r) => setTimeout(r, 10_000));
    const hz = Number(execFileSync('getconf', ['CLK_TCK']).toString().trim());
    let requestsDuringIdle = 0;
    const polled = {};
    for (const page of open) {
      page.on('request', () => { requestsDuringIdle += 1; });
      page.on('requestfinished', async (request) => {
        const where = new URL(request.url()).pathname;
        const sizes = await request.sizes().catch(() => null);
        const seen = (polled[where] ??= { count: 0, body_kib: 0 });
        seen.count += 1;
        seen.body_kib = +(seen.body_kib + (sizes?.responseBodySize ?? 0) / 1024).toFixed(1);
      });
    }
    const t0 = cpuTicks(child.pid);
    const began = Date.now();
    await new Promise((r) => setTimeout(r, idleSeconds * 1000));
    const cpuMs = ((cpuTicks(child.pid) - t0) / hz) * 1000;
    const wall = (Date.now() - began) / 1000;
    report.idle = {
      seconds: +wall.toFixed(1),
      server_cpu_ms_per_min: Math.round((cpuMs / wall) * 60),
      browser_requests_per_min: +((requestsDuringIdle / wall) * 60).toFixed(1),
      polled,
    };
    report.memory.after_idle = memory(child.pid);
    await context.close();
  }
  await browser.close();
} finally {
  await stop(child);
  if (!args.keep) rmSync(run, { recursive: true, force: true });
  report.ports_released = ports;
}
console.log(JSON.stringify(report, null, 2));
