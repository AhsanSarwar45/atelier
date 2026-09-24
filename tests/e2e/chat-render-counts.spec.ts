import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

/**
 * Which components React actually runs for one keystroke, one streamed word
 * and one new row (bw-4slk).
 *
 * Timing a keystroke says whether this machine kept up. It cannot say what was
 * redrawn to get there, and "the whole chat" is the complaint. This hooks
 * React's own commit, the same way its developer tools do, and names every
 * component that ran.
 *
 * Names need a build that keeps them: RENDER_NAMES=1 scripts/workbench-e2e.sh
 * tests/e2e/chat-render-counts.spec.ts
 */

const CHAT = 'render-counts';
const WAIT = 60_000;
const HELD = 60;
const OTHERS = 40;

function git(at: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: at, stdio: 'pipe' });
}

function seed(where: string): void {
  rmSync(where, { recursive: true, force: true });
  mkdirSync(join(where, 'src'), { recursive: true });
  writeFileSync(join(where, 'README.md'), '# Render counts\n');
  writeFileSync(join(where, 'src', 'main.ts'), 'export const main = 1;\n');
  git(where, 'init', '-q', '-b', 'main', '.');
  git(where, 'config', 'user.name', 'A Counter');
  git(where, 'config', 'user.email', 'counter@atelier.test');
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

/** A conversation shaped like a working one: prose, thinking, and tool calls between. */
function held(): WbpEvent[] {
  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture', model: 'opus', cwd: '', permissionMode: 'on-request' } as WbpEvent,
  ];
  let seq = 1;
  const add = (e: Record<string, unknown>) => events.push({ ...base, seq: (seq += 1), ...e } as WbpEvent);
  for (let i = 0; i < HELD; i += 1) {
    const u = `u${i}`;
    add({ type: 'message.started', messageId: u, role: 'user' });
    add({ type: 'text.delta', messageId: u, text: `Please look at \`src/file-${i}.ts\` and fix thing ${i}.` });
    add({ type: 'message.completed', messageId: u });
    const t = `t${i}`;
    add({ type: 'message.started', messageId: t, role: 'assistant' });
    add({ type: 'thinking.delta', messageId: t, text: `Thinking about thing ${i}. It is in **file ${i}**.` });
    add({ type: 'message.completed', messageId: t });
    for (let k = 0; k < 3; k += 1) {
      const id = `tool-${i}-${k}`;
      add({ type: 'tool.started', toolCallId: id, name: k === 0 ? 'Read' : k === 1 ? 'Bash' : 'Edit', input: k === 1 ? { command: `rg thing${i} src` } : { file_path: `/tmp/src/file-${i}.ts` }, title: `step ${k} of ${i}`, parentToolCallId: null });
      add({ type: 'tool.completed', toolCallId: id, ok: true, output: `line one\nline two of ${i}` });
    }
    const a = `a${i}`;
    add({ type: 'message.started', messageId: a, role: 'assistant' });
    add({ type: 'text.delta', messageId: a, text: `## Done ${i}\n\nChanged \`file-${i}.ts\`:\n\n- one\n- two\n\n\`\`\`ts\nexport const x${i} = ${i};\n\`\`\`\n` });
    add({ type: 'message.completed', messageId: a });
  }
  add({ type: 'session.state', state: 'idle', label: 'Ready' });
  return events;
}

function everySession(projectId: string, projectPath: string) {
  const one = (id: string, title: string, state: string) => ({
    id, brand: 'claude', externalId: id, projectId, projectPath, cwd: projectPath, model: 'opus', permissionMode: 'on-request',
    title, state, createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(),
    activity: state === 'streaming' ? 'Writing' : 'Idle', activityDetail: '', activityCall: null, beads: [],
  });
  const all = [one(CHAT, 'Counting renders', 'idle')];
  for (let i = 0; i < OTHERS; i += 1) all.push(one(`other-${i}`, `Another chat ${i}`, i % 3 === 0 ? 'streaming' : 'idle'));
  return all;
}

type Counts = { rendered: Record<string, number>; mounted: Record<string, number>; commits: number; zones: Record<string, number>; starts: string[] };

test('what one keystroke, one word and one new row cause React to run', async ({ page, request }) => {
  test.setTimeout(300_000);
  const fixture = join(__dirname, '..', '.workbench-run-render-counts');
  seed(fixture);
  page.on('pageerror', (e) => console.log(`PAGEERROR ${e.message}`));

  const events = held();
  const lastSeq = events[events.length - 1].seq;
  const project = await fixtureProject(request, 'render-counts', fixture);
  const sessions = everySession(project.id, fixture);

  await page.addInitScript(
    ({ chat, view, from, everySession }) => {
      // React's commits, read the way its developer tools read them: a fiber
      // ran if it was reached through a reconciled parent and carries the
      // PerformedWork flag; a subtree whose child pointer did not move was
      // not visited at all.
      const rendered: Record<string, number> = {};
      const mounted: Record<string, number> = {};
      let commits = 0;
      const nameOf = (f: any): string | null => {
        const t = f.type;
        if (!t || typeof t === 'string') return null;
        if (f.tag === 0 || f.tag === 1 || f.tag === 15) return t.displayName || t.name || 'Anonymous';
        if (f.tag === 11) return t.displayName || t.render?.displayName || t.render?.name || 'ForwardRef';
        return null;
      };
      const bump = (map: Record<string, number>, f: any) => {
        const n = nameOf(f);
        if (n) map[n] = (map[n] ?? 0) + 1;
      };
      const mountAll = (f: any) => {
        for (let c = f; c; c = c.sibling) {
          bump(mounted, c);
          if (c.child) mountAll(c.child);
        }
      };
      // Which part of the screen each render belongs to, by its nearest
      // named ancestor, and which component began each commit.
      const ZONES = new Set(['ChatSidebar', 'ChatRightRail', 'DrawnTranscript', 'ComposerBody', 'SessionConfigPickers', 'SendButtons', 'HeldMessages', 'TabTools', 'TabLead', 'TabTrail', 'ChatTab', 'WorkbenchStatus']);
      const zones: Record<string, number> = {};
      const starts: string[] = [];
      const walk = (next: any, zone: string, above: boolean) => {
        for (let c = next; c; c = c.sibling) {
          const prev = c.alternate;
          const n = nameOf(c);
          const here = n && ZONES.has(n) ? n : zone;
          if (!prev) {
            bump(mounted, c);
            if (c.child) mountAll(c.child);
            continue;
          }
          const ran = Boolean(c.flags & 1) && n !== null;
          if (ran) {
            bump(rendered, c);
            zones[here] = (zones[here] ?? 0) + 1;
            if (!above) starts.push(n!);
          }
          if (c.child && c.child !== prev.child) walk(c.child, here, above || ran);
        }
      };
      (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true,
        renderers: new Map(),
        inject() { return 1; },
        checkDCE() {},
        onScheduleFiberRoot() {},
        onCommitFiberUnmount() {},
        onPostCommitFiberRoot() {},
        onCommitFiberRoot(_id: number, root: any) {
          commits += 1;
          const cur = root.current;
          const prev = cur.alternate;
          if (!prev || prev.child === null) { if (cur.child) mountAll(cur.child); return; }
          if (cur.child !== prev.child) walk(cur.child, 'app', false);
        },
      };
      (window as any).__renders = {
        reset() { starts.length = 0; for (const k of Object.keys(zones)) delete zones[k]; for (const k of Object.keys(rendered)) delete rendered[k]; for (const k of Object.keys(mounted)) delete mounted[k]; commits = 0; },
        read: () => ({ rendered: { ...rendered }, mounted: { ...mounted }, commits, zones: { ...zones }, starts: [...starts] }),
      };

      class FixtureSocket {
        static OPEN = 1;
        static CLOSED = 3;
        readyState = FixtureSocket.OPEN;
        onmessage: ((event: MessageEvent) => void) | null = null;
        constructor(url: string) {
          if (new URL(url).searchParams.get('chat') !== chat) return;
          const push = (frame: unknown) => this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
          setTimeout(() => push({ tag: 'workbench', data: JSON.stringify({ kind: 'snapshot', sessions: everySession }) }), 0);
          setTimeout(() => push({ tag: 'chat.snapshot', scope: chat, data: JSON.stringify(view) }), 0);
          let seq = from;
          const say = (event: Record<string, unknown>) => {
            const full = { sessionId: chat, seq: (seq += 1), at: new Date().toISOString(), ...event };
            push({ tag: 'chat', scope: chat, data: JSON.stringify(full) });
            push({ tag: 'workbench', data: JSON.stringify({ kind: 'event', event: full }) });
          };
          Object.defineProperty(window, '__say', { configurable: true, value: say });
        }
        close() { this.readyState = FixtureSocket.CLOSED; }
        send() {}
      }
      Object.defineProperty(window, 'WebSocket', { value: FixtureSocket, configurable: true });
    },
    { chat: CHAT, view: foldAll(events), from: lastSeq, everySession: sessions },
  );

  await seeTestProjects(page);
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) =>
    route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'claude', externalId: 'fixture', runningElsewhere: false, held: null, title: 'Counting renders', cwd: fixture, beads: [] } }),
  );

  await page.goto(`/project?id=${project.id}&tab=chat&chat=${CHAT}`);
  await expect(page.getByTestId('transcript')).toBeVisible({ timeout: WAIT });
  await page.waitForTimeout(3_000);
  const writing = page.getByTestId('composer-frame').locator('.cm-content');
  await writing.click();
  await page.keyboard.type('warm');
  await page.waitForTimeout(1_000);

  const say = (e: Record<string, unknown>) => page.evaluate((ev) => (window as any).__say(ev), e);
  const measure = async (label: string, act: () => Promise<unknown>): Promise<Counts> => {
    await page.evaluate(() => (window as any).__renders.reset());
    await act();
    await page.waitForTimeout(600);
    const counts = (await page.evaluate(() => (window as any).__renders.read())) as Counts;
    const top = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(' ');
    const total = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);
    console.log(`RENDERS ${label}: commits=${counts.commits} rendered=${total(counts.rendered)} mounted=${total(counts.mounted)}`);
    console.log(`RENDERS   by part of the screen: ${top(counts.zones)}`);
    console.log(`RENDERS   began at: ${counts.starts.join(', ')}`);
    if (process.env.RENDER_ALL) console.log(`RENDERS   ran: ${top(counts.rendered)}`);
    console.log(`RENDERS   mounted: ${top(counts.mounted)}`);
    return counts;
  };

  const keystroke = await measure('one keystroke', () => page.keyboard.type('x'));
  await say({ type: 'message.started', messageId: 'live', role: 'assistant' });
  await say({ type: 'session.state', state: 'streaming', label: 'Writing' });
  await say({ type: 'text.delta', messageId: 'live', text: 'The first words. ' });
  await page.waitForTimeout(800);
  const word = await measure('one streamed word', () => say({ type: 'text.delta', messageId: 'live', text: 'another word ' }));
  const keyWhileStreaming = await measure('one keystroke while streaming', () => page.keyboard.type('y'));
  const toolCall = await measure('a new tool call', () => say({ type: 'tool.started', toolCallId: 'new-tool', name: 'Bash', input: { command: 'ls' }, title: 'ls', parentToolCallId: null }));
  const toolDone = await measure('that tool finishing', () => say({ type: 'tool.completed', toolCallId: 'new-tool', ok: true, output: 'a\nb' }));
  const message = await measure('a new message', async () => {
    await say({ type: 'message.completed', messageId: 'live' });
    await say({ type: 'message.started', messageId: 'live2', role: 'assistant' });
    await say({ type: 'text.delta', messageId: 'live2', text: 'A second answer.' });
  });

  // What each event may cost, counted in components run so the numbers hold
  // in a minified build. A chat that redrew its list of chats, or its whole
  // transcript, ran close to two thousand for every one of these (bw-4slk.1);
  // bw-j29w then kept the frame around a chat still while its words stream:
  // a word must run under sixty and a new row under a hundred and fifty. A
  // new message is three events — the last one finishing, the next starting,
  // its first word — so it may run three rows' worth.
  const ran = (c: Counts) => Object.values(c.rendered).reduce((a, b) => a + b, 0);
  expect(ran(keystroke), 'a keystroke redrew more than the box it was typed in').toBeLessThanOrEqual(60);
  expect(ran(keyWhileStreaming), 'a keystroke while the agent talks redrew more than the box').toBeLessThanOrEqual(80);
  expect(ran(word), 'one streamed word redrew far more than the message it lands in').toBeLessThan(60);
  expect(Object.keys(word.mounted), 'one streamed word rebuilt parts of the screen').toEqual([]);
  expect(ran(toolCall), 'a new tool call redrew far more than its own row').toBeLessThan(150);
  expect(ran(toolDone), 'a tool finishing redrew far more than its own row').toBeLessThan(150);
  expect(ran(message), 'a new message redrew far more than its own row').toBeLessThan(3 * 150);
});
