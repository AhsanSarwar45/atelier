import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

/**
 * Typing stays smooth, whatever the chat is doing (bw-zez4).
 *
 * The owner reported it off the running app: "when chat is updating, writing in
 * the chatbox becomes stuttery" — and then, which is the sharper half of it,
 * that it is slow with the chat sitting still too, and worst on a phone. A
 * writing box is the one part of a screen that may never wait. Whatever else
 * the app is doing, the character belongs on the screen on the next frame.
 *
 * Both halves were the same fault. The line being typed was a piece of the chat
 * screen's own state, so every character redrew the whole screen: the
 * transcript, its virtualiser, every message in it, and a row of ten pickers
 * that have nothing to do with what is being written. An arriving word redrew
 * the same screen, which is why the two complaints stacked.
 *
 * scripts/chat-typing-cost.mjs already asks what a keystroke costs, but it asks
 * it of a chat sitting still on THIS machine. This case asks both questions at
 * once, on a processor four times slower than the one it runs on, because the
 * complaint is worst on a phone and a phone is a slow processor rather than a
 * slow network.
 *
 * It types the same sentence twice into the same chat — once with the chat
 * idle, once while an answer streams into it. The idle run carries a budget of
 * its own, and the streaming run is measured against the idle one: an arriving
 * word costs the transcript a redraw, and it must cost the writing box nothing.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/typing-stays-smooth-while-the-agent-streams.spec.ts
 */

const SHOTS = 'tests/results/typing-stays-smooth-while-the-agent-streams';
const WAIT = 60_000;
const CHAT = 'typing-while-streaming';

/** How many messages are already in the chat before anyone types. */
const HELD = 120;
/** The sentence typed in each run. */
const TYPED = 'the quick brown fox jumps over the lazy dog';
/**
 * How often a word arrives while the sentence is being typed.
 *
 * An agent answering at speed sends a delta every few milliseconds, and the
 * app folds every one of them. 5ms is that agent.
 */
const EVERY_MS = Number(process.env.TYPING_EVERY_MS ?? 5);
/**
 * How long the answer has already been streaming before anyone starts typing.
 *
 * This is the axis the complaint is really on. A growing message is re-read
 * from its first character on every frame, so what a keystroke costs depends
 * on how much the agent has ALREADY said — and the owner types into a chat
 * mid-answer, not at the first word of one.
 */
const WARMUP_MS = Number(process.env.TYPING_WARMUP_MS ?? 8_000);

/**
 * What a keystroke may cost while an answer streams, as a multiple of what the
 * same keystroke costs in the same chat sitting still.
 *
 * A multiple rather than a number of milliseconds, because the control run is
 * measured on the same machine in the same browser a moment earlier: this asks
 * whether the stream is what made typing slow, which is the complaint, and it
 * asks it the same way on a fast machine and a slow one.
 */
const SPREAD = 2;
/**
 * The longest a single frame may take while the sentence is typed.
 *
 * A stutter IS a long frame: the character was ready and the browser was busy.
 * 50ms is the browser's own name for a task too long to stay responsive.
 */
const WORST_FRAME_MS = 50;
/**
 * The longest a keystroke may take with the chat sitting still.
 *
 * On the slowed-down processor below, which is the phone the complaint is
 * about. The same number `scripts/chat-typing-cost.mjs` holds a long
 * conversation to, because a keystroke is a keystroke.
 */
const QUIET_KEY_MS = 16;

function git(at: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd: at,
    stdio: 'pipe',
  });
}

function seed(where: string): void {
  rmSync(where, { recursive: true, force: true });
  mkdirSync(join(where, 'src'), { recursive: true });
  writeFileSync(join(where, 'README.md'), '# Typing while streaming\n\nA paragraph.\n');
  writeFileSync(join(where, 'src', 'main.ts'), 'export const main = 1;\n');

  git(where, 'init', '-q', '-b', 'main', '.');
  git(where, 'config', 'user.name', 'A Typist');
  git(where, 'config', 'user.email', 'typist@atelier.test');
  git(where, 'config', 'commit.gpgsign', 'false');
  git(where, 'add', '-A');
  git(where, 'commit', '-qm', 'seed');
}

async function fixtureProject(request: APIRequestContext, name: string, path: string) {
  const made = await request.post('/api/projects', { data: { name, path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

async function seeTestProjects(page: Page): Promise<void> {
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
}

/** A conversation of the shape the app actually draws: prose, a list, a fence. */
function held(): WbpEvent[] {
  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    {
      ...base,
      seq: 1,
      type: 'session.started',
      brand: 'claude',
      externalId: 'fixture',
      model: 'opus',
      cwd: '',
      permissionMode: 'on-request',
    } as WbpEvent,
  ];
  let seq = 1;
  for (let i = 0; i < HELD; i += 1) {
    const messageId = `m${i}`;
    const role = i % 2 ? 'assistant' : 'user';
    const said =
      `## Message ${i}\n\nSomething said about \`file-${i}.ts\`, with a list:\n\n` +
      `- one\n- two\n- three\n\n\`\`\`ts\nexport function thing${i}(a: number): number {\n  return a * ${i};\n}\n\`\`\`\n`;
    events.push({ ...base, seq: (seq += 1), type: 'message.started', messageId, role } as WbpEvent);
    events.push({ ...base, seq: (seq += 1), type: 'text.delta', messageId, text: said } as WbpEvent);
    events.push({ ...base, seq: (seq += 1), type: 'message.completed', messageId } as WbpEvent);
  }
  events.push({ ...base, seq: (seq += 1), type: 'session.state', state: 'idle', label: 'Ready' } as WbpEvent);
  return events;
}

/**
 * How many other chats the app knows about while this one is being typed in.
 *
 * The owner runs many agents at once, so his list is long; the fixture's was
 * empty, and an empty list is the one case where redrawing it on every arriving
 * word costs nothing. The complaint comes from a full one.
 */
const OTHERS = 40;

/** The app-wide picture: the chat being read, and the ones beside it. */
function everySession(projectId: string, projectPath: string) {
  const one = (id: string, title: string, state: string) => ({
    id,
    brand: 'claude',
    externalId: id,
    projectId,
    projectPath,
    cwd: projectPath,
    model: 'opus',
    permissionMode: 'on-request',
    title,
    state,
    createdAt: new Date(0).toISOString(),
    lastActiveAt: new Date(0).toISOString(),
    activity: state === 'streaming' ? 'Writing' : 'Idle',
    activityDetail: '',
    activityCall: null,
    beads: [],
  });
  const all = [one(CHAT, 'Typing while the agent talks', 'idle')];
  for (let i = 0; i < OTHERS; i += 1) {
    // Some of them working, as his really are: a row that is working draws a
    // counting chip, and that is the row that costs something to redraw.
    all.push(one(`other-${i}`, `Another chat about thing ${i}`, i % 3 === 0 ? 'streaming' : 'idle'));
  }
  return all;
}

/** What one run of the sentence cost. */
interface Run {
  perKeyMedian: number;
  perKeyWorst: number;
  worstFrame: number;
  longTasks: number;
  longTaskMs: number;
  deltasArrived: number;
  /** How long the answer had grown to by the time the sentence was typed. */
  answerChars: number;
}

function median(list: number[]): number {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

test('a keystroke costs the same whether or not the agent is talking', async ({ page, request }) => {
  test.setTimeout(600_000);
  const fixture = join(__dirname, '..', '.workbench-run-typing-while-streaming');
  seed(fixture);

  page.on('pageerror', (e) => console.log(`PAGEERROR ${e.message}`));

  const events = held();
  const lastSeq = events[events.length - 1].seq;
  // Made before the page exists, because the app-wide picture pushed into the
  // socket names the project every chat in it belongs to.
  const project = await fixtureProject(request, 'typing-while-streaming', fixture);
  const sessions = everySession(project.id, fixture);

  // The app opens exactly one socket for the window and everything arrives on
  // it. The fixture answers it and keeps the instance, so the case can push
  // frames into an OPEN chat afterwards — which is the whole point: the
  // complaint is about what arrives WHILE somebody types.
  await page.addInitScript(
    ({ chat, view, from, everySession }) => {
      class FixtureSocket {
        static OPEN = 1;
        static CLOSED = 3;
        readyState = FixtureSocket.OPEN;
        onmessage: ((event: MessageEvent) => void) | null = null;
        constructor(url: string) {
          if (new URL(url).searchParams.get('chat') !== chat) return;
          const push = (frame: unknown) =>
            this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
          // The app-wide picture FIRST, and it must contain the chat being
          // read. The store drops an event about a session it has never heard
          // of, so a case that skipped this would leave the whole app-wide
          // half of the app asleep and measure only the transcript's own
          // relay — which is half the redraw an arriving word really causes.
          setTimeout(
            () => push({ tag: 'workbench', data: JSON.stringify({ kind: 'snapshot', sessions: everySession }) }),
            0,
          );
          setTimeout(() => push({ tag: 'chat.snapshot', scope: chat, data: JSON.stringify(view) }), 0);

          let seq = from;
          let sent = 0;
          let chars = 0;
          let beat: ReturnType<typeof setInterval> | null = null;
          const say = (event: Record<string, unknown>) => {
            // Both feeds, because the real server sends both for one event: the
            // open chat's own ordered relay, and the app-wide one the sidebar
            // and the chat's own header read. A case that pushed only the
            // first would be measuring half the app.
            push({ tag: 'chat', scope: chat, data: JSON.stringify(event) });
            push({ tag: 'workbench', data: JSON.stringify({ kind: 'event', event }) });
          };
          const at = () => new Date().toISOString();
          Object.defineProperty(window, '__stream', {
            configurable: true,
            value: {
              start(everyMs: number) {
                sent = 0;
                chars = 0;
                say({ sessionId: chat, seq: (seq += 1), at: at(), type: 'message.started', messageId: 'live', role: 'assistant' });
                say({ sessionId: chat, seq: (seq += 1), at: at(), type: 'session.state', state: 'streaming', label: 'Writing' });
                beat = setInterval(() => {
                  sent += 1;
                  const words =
                    sent % 8 === 0
                      ? `\n\n\`\`\`ts\nexport const step${sent} = ${sent};\n\`\`\`\n\n`
                      : `word ${sent} of the answer being written, about \`thing-${sent}.ts\`. `;
                  chars += words.length;
                  say({
                    sessionId: chat,
                    seq: (seq += 1),
                    at: at(),
                    type: 'text.delta',
                    messageId: 'live',
                    // A growing answer, in the shape agents really send: prose
                    // with code in it, arriving a clause at a time.
                    text: words,
                  });
                }, everyMs);
              },
              stop() {
                if (beat) clearInterval(beat);
                beat = null;
                say({ sessionId: chat, seq: (seq += 1), at: at(), type: 'message.completed', messageId: 'live' });
                say({ sessionId: chat, seq: (seq += 1), at: at(), type: 'session.state', state: 'idle', label: 'Ready' });
                return { sent, chars };
              },
              sent: () => sent,
            },
          });
        }
        close() {
          this.readyState = FixtureSocket.CLOSED;
        }
        send() {}
      }
      Object.defineProperty(window, 'WebSocket', { value: FixtureSocket, configurable: true });

      // The two things a stutter is made of, watched from the moment the page
      // exists: a frame that took too long, and a task that held the thread.
      const frames: number[] = [];
      const tasks: number[] = [];
      let last = performance.now();
      const beat = () => {
        const now = performance.now();
        frames.push(now - last);
        last = now;
        requestAnimationFrame(beat);
      };
      requestAnimationFrame(beat);
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) tasks.push(entry.duration);
      }).observe({ entryTypes: ['longtask'] });
      Object.defineProperty(window, '__jank', {
        configurable: true,
        value: {
          reset() {
            frames.length = 0;
            tasks.length = 0;
            last = performance.now();
          },
          read: () => ({ frames: [...frames], tasks: [...tasks] }),
        },
      });
    },
    { chat: CHAT, view: foldAll(events), from: lastSeq, everySession: sessions },
  );

  await seeTestProjects(page);
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) =>
    route.fulfill({
      json: {
        sessionId: CHAT,
        origin: 'terminal',
        brand: 'claude',
        externalId: 'fixture',
        runningElsewhere: false,
        held: null,
        title: 'Typing while the agent talks',
        cwd: fixture,
        beads: [],
      },
    }),
  );

  mkdirSync(SHOTS, { recursive: true });

  await page.goto(`/project?id=${project.id}&tab=chat&chat=${CHAT}`);
  await expect(page.getByTestId('transcript')).toBeVisible({ timeout: WAIT });
  // The transcript settles once — a virtualiser measuring a hundred rows for
  // the first time is not what anyone is complaining about.
  await page.waitForTimeout(3_000);

  await page.screenshot({ path: `${SHOTS}/00-opened.png`, animations: 'disabled' });
  const writing = page.getByTestId('composer-frame').locator('.cm-content');
  await writing.click();

  /** Type the sentence, timing each character, with the jank watch running. */
  async function type(): Promise<Omit<Run, 'deltasArrived'>> {
    await page.evaluate(() => (window as unknown as { __jank: { reset(): void } }).__jank.reset());
    const each: number[] = [];
    for (const ch of TYPED) {
      const at = Date.now();
      await page.keyboard.type(ch);
      each.push(Date.now() - at);
    }
    const seen = await page.evaluate(
      () => (window as unknown as { __jank: { read(): { frames: number[]; tasks: number[] } } }).__jank.read(),
    );
    // The first frame of a watch spans the gap before it started.
    const frames = seen.frames.slice(1);
    return {
      perKeyMedian: median(each),
      perKeyWorst: Math.max(...each),
      worstFrame: Math.round(Math.max(0, ...frames)),
      longTasks: seen.tasks.length,
      longTaskMs: Math.round(seen.tasks.reduce((a, b) => a + b, 0)),
    };
  }

  // How much slower than this machine the measurement pretends to be.
  //
  // The complaint is worst on a phone, and a phone is not a slow network — it
  // is a slow processor. Everything here is main-thread work, so slowing the
  // thread down is exactly what a phone does to it. 1 is this machine.
  const SLOWER = Number(process.env.TYPING_SLOWER ?? 4);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  if (SLOWER > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: SLOWER });

  // The control: the same box, the same chat, nothing arriving.
  const quiet: Run = { ...(await type()), deltasArrived: 0, answerChars: 0 };
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(1_000);

  // What the stream costs the thread, before anyone types into it.
  //
  // Wall-clock around a keystroke says whether THIS machine kept up; it cannot
  // say how much room was left. This can: the browser's own accounting of the
  // thread, over a fixed run of the stream with the box left alone. It is the
  // number the complaint is really about, because the room left over is what a
  // keystroke has to fit into — and on the owner's machine there is less of it.
  const thread = async (): Promise<Record<string, number>> => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  };

  // The same page with nothing arriving, so the stream's cost can be told apart
  // from what the page costs just being open.
  if (process.env.TYPING_IDLE) {
    const idleFrom = await thread();
    await page.waitForTimeout(WARMUP_MS);
    const idleTo = await thread();
    console.log(`PERF idle     ${JSON.stringify({
      scriptMs: Math.round((idleTo.ScriptDuration - idleFrom.ScriptDuration) * 1000),
      taskMs: Math.round((idleTo.TaskDuration - idleFrom.TaskDuration) * 1000),
      overMs: WARMUP_MS,
    })}`);
  }
  const before = await thread();
  if (process.env.TYPING_PROFILE) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdp.send('Profiler.start');
  }
  // What the browser itself spent the thread on, by the name of each piece of
  // work, when the profile says most of it was not script at all.
  const traced: Array<{ name: string; dur?: number; ph: string; tid: number; args?: { name?: string } }> = [];
  let tracingDone: Promise<void> | null = null;
  if (process.env.TYPING_TRACE) {
    cdp.on('Tracing.dataCollected', ({ value }) => { traced.push(...(value as typeof traced)); });
    tracingDone = new Promise((resolve) => cdp.once('Tracing.tracingComplete', () => resolve()));
    await cdp.send('Tracing.start', {
      traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'v8', '__metadata'] },
      transferMode: 'ReportEvents',
    });
  }
  await page.evaluate((everyMs) => (window as unknown as { __stream: { start(ms: number): void } }).__stream.start(everyMs), EVERY_MS);
  await page.waitForTimeout(WARMUP_MS);
  const after = await thread();
  if (tracingDone) {
    await cdp.send('Tracing.end');
    await tracingDone;
    const main = new Set(traced.filter((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain').map((e) => e.tid));
    // Self time: each piece of work less the pieces nested inside it.
    const spent = new Map<string, number>();
    const work = traced
      .filter((e) => e.ph === 'X' && main.has(e.tid) && e.dur)
      .map((e) => ({ name: e.name, ts: (e as unknown as { ts: number }).ts, dur: e.dur! }))
      .sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    const open: Array<{ name: string; end: number; self: number }> = [];
    const close = (upTo: number) => {
      while (open.length && open[open.length - 1]!.end <= upTo) {
        const done = open.pop()!;
        spent.set(done.name, (spent.get(done.name) ?? 0) + done.self);
      }
    };
    for (const e of work) {
      close(e.ts);
      if (open.length) open[open.length - 1]!.self -= e.dur;
      open.push({ name: e.name, end: e.ts + e.dur, self: e.dur });
    }
    close(Infinity);
    for (const [name, us] of [...spent.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
      console.log(`TRACE ${String(Math.round(us / 1000)).padStart(6)}ms  ${name}`);
    }
  }
  if (process.env.TYPING_PROFILE) {
    const { profile } = await cdp.send('Profiler.stop');
    // Self time per function, so the run names what it spent the thread on
    // rather than leaving it to be guessed at.
    const self = new Map<string, number>();
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const total = (profile.timeDeltas ?? []).reduce((a, b) => a + b, 0);
    (profile.samples ?? []).forEach((id, i) => {
      const node = byId.get(id);
      if (!node) return;
      const f = node.callFrame;
      const where = `${f.functionName || '(anonymous)'} ${String(f.url).split('/').pop()}:${f.lineNumber}`;
      self.set(where, (self.get(where) ?? 0) + (profile.timeDeltas?.[i] ?? 0));
    });
    const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
    console.log(`PERF profile over ${Math.round(total / 1000)}ms`);
    for (const [where, us] of top) {
      console.log(`PERF   ${String(Math.round(us / 1000)).padStart(6)}ms  ${Math.round((us / total) * 100)}%  ${where}`);
    }
  }
  const sentSoFar = await page.evaluate(() => (window as unknown as { __stream: { sent(): number } }).__stream.sent());
  const cost = {
    deltas: sentSoFar,
    scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000),
    layoutMs: Math.round((after.LayoutDuration - before.LayoutDuration) * 1000),
    styleMs: Math.round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000),
    taskMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000),
    overMs: WARMUP_MS,
  };
  console.log(
    `PERF stream   ${JSON.stringify({ ...cost, perDeltaMs: Math.round((cost.taskMs / Math.max(cost.deltas, 1)) * 100) / 100, threadBusyPercent: Math.round((cost.taskMs / cost.overMs) * 100) })}`,
  );
  await page.evaluate(() => (window as unknown as { __stream: { stop(): unknown } }).__stream.stop());
  await page.waitForTimeout(1_000);

  // And now the complaint.
  await page.evaluate((everyMs) => (window as unknown as { __stream: { start(ms: number): void } }).__stream.start(everyMs), EVERY_MS);
  // Let the answer get as long as the one he was actually typing into.
  await page.waitForTimeout(WARMUP_MS);
  const talking: Run = { ...(await type()), deltasArrived: 0, answerChars: 0 };
  const streamed = await page.evaluate(
    () => (window as unknown as { __stream: { stop(): { sent: number; chars: number } } }).__stream.stop(),
  );
  talking.deltasArrived = streamed.sent;
  talking.answerChars = streamed.chars;

  await page.screenshot({ path: `${SHOTS}/typed-while-streaming.png`, animations: 'disabled' });

  console.log(`PERF quiet    ${JSON.stringify(quiet)}`);
  console.log(`PERF talking  ${JSON.stringify(talking)}`);

  // The stream really did arrive, or the case proved nothing.
  expect(talking.deltasArrived, 'no words arrived while typing; the case measured silence').toBeGreaterThan(20);

  // The box drew what was typed, whatever it cost.
  await expect(page.getByTestId('composer')).toHaveValue(TYPED, { timeout: WAIT });

  // The idle run on its own, which is the half of the complaint that has
  // nothing to do with the stream: a phone typing into a chat that is doing
  // nothing at all.
  expect(
    quiet.perKeyMedian,
    `a keystroke cost ${quiet.perKeyMedian}ms in a chat sitting still, on a processor ${SLOWER}x slower ` +
      'than this one; a box that is only being typed into must not cost that',
  ).toBeLessThanOrEqual(QUIET_KEY_MS);

  expect(
    quiet.longTasks,
    `typing into a still chat blocked the thread ${quiet.longTasks} times for ${quiet.longTaskMs}ms in all; ` +
      'a character must never be what makes the browser stop',
  ).toBe(0);

  expect(
    talking.worstFrame,
    `a frame took ${talking.worstFrame}ms while the agent talked (${quiet.worstFrame}ms quiet); ` +
      'a character was ready and the browser was busy',
  ).toBeLessThanOrEqual(WORST_FRAME_MS);

  expect(
    talking.perKeyMedian,
    `a keystroke cost ${talking.perKeyMedian}ms while the agent talked against ${quiet.perKeyMedian}ms in the same chat ` +
      'sitting still; what arrives must not be what it costs to type',
  ).toBeLessThanOrEqual(Math.max(quiet.perKeyMedian, 4) * SPREAD);
});
