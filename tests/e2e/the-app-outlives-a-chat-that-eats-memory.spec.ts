import { expect, test, type APIRequestContext } from '@playwright/test';

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { command, processesOf } from './fixture-held';

/**
 * The app outlives a chat that eats its memory (bw-jb5nf).
 *
 * Every chat, and every build a chat runs, is charged to the app's own systemd
 * service. When that service runs short, the kernel stalls every process in it,
 * the server too, so screens say the app gave no answer; twenty seconds later
 * `systemd-oomd` kills the service and every chat with it. Now the chat holding
 * the most is stopped first and told why, and the rest carry on.
 *
 * It needs the stack in a small service of its own, so the squeeze is real and
 * nobody else's memory is touched:
 *
 *   systemd-run --user --unit=bw-jb5nf-e2e --same-dir --wait --pipe --collect \
 *     -p MemoryHigh=2500M -p MemoryMax=5G -p MemorySwapMax=0 \
 *     --setenv=... scripts/workbench-e2e.sh tests/e2e/the-app-outlives-a-chat-that-eats-memory.spec.ts
 */

const ownGroup = readFileSync('/proc/self/cgroup', 'utf8').trim();
test.skip(
  !process.env.BEADS_E2E_ACP_ADAPTERS?.includes('tests/fixtures/acp-adapters') || !ownGroup.endsWith('.service'),
  'needs the scripted ACP agent and a systemd service of its own; see the header',
);

const OWN_PROJECT_DIR = join(__dirname, '..', '.held-run');
const SHOTS = join(process.cwd(), 'tests', 'results');

async function aProject(request: APIRequestContext) {
  const dir = join(OWN_PROJECT_DIR, `memory-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  const made = await request.post('/api/projects', { data: { name: 'held-memory', path: dir } });
  expect(made.status(), `could not make a project: ${await made.text()}`).toBe(201);
  const project = (await made.json()) as { id: string; path: string };
  return {
    ...project,
    remove: async () => {
      await request.delete(`/api/projects/${project.id}`);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The command the scripted agent left growing for a chat, while it runs. */
function growers(chat: string): number[] {
  return processesOf(chat).filter((pid) => {
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      return args[1] === '-e' && args[2]?.includes('held.push');
    } catch {
      return false;
    }
  });
}

/** Who a process is, for a failure message. */
function described(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const [state, ppid, pgid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return `${pid} state=${state} parent=${ppid} group=${pgid}`;
  } catch {
    return `${pid} gone`;
  }
}

test('a chat starving the app is stopped and the app keeps answering', async ({ page, request }) => {
  test.setTimeout(300_000);
  const project = await aProject(request);
  let greedyChat: string | undefined;
  try {
    const start = async () => {
      const started = await command(request, {
        type: 'session.start', projectId: project.id, projectPath: project.path, brand: 'claude',
      });
      expect(started.ok, `could not start a chat: ${started.body}`).toBe(true);
      return started.said.id!;
    };
    const quiet = await start();
    const greedy = await start();
    greedyChat = greedy;
    expect((await command(request, { type: 'prompt.send', sessionId: quiet, text: 'say you read this' })).ok).toBe(true);

    await page.goto(`/project?id=${project.id}&tab=chat`);
    await page.locator(`[data-testid="restore-row"][data-row-key="${greedy}"]`).waitFor({ timeout: 120_000 });

    const origin = process.env.BEADS_E2E_URL!;
    const health: number[] = [];
    let failed = 0;
    let probing = true;
    const probe = (async () => {
      while (probing) {
        const at = Date.now();
        try {
          const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(15_000) });
          await res.arrayBuffer();
          if (!res.ok) failed += 1;
        } catch {
          failed += 1;
        }
        health.push(Date.now() - at);
        await new Promise((settle) => setTimeout(settle, 500));
      }
    })();

    expect((await command(request, { type: 'prompt.send', sessionId: greedy, text: 'hold memory' })).ok).toBe(true);
    await expect.poll(() => growers(greedy).length, { timeout: 30_000 }).toBeGreaterThan(0);
    const startedAt = Date.now();

    // The whole of it: what the greedy chat started is gone, well inside the
    // twenty seconds `systemd-oomd` would have waited before killing it all.
    await expect
      .poll(() => growers(greedy).map(described).join('; '), { timeout: 60_000, intervals: [500] })
      .toBe('');
    const stoppedInMs = Date.now() - startedAt;
    probing = false;
    await probe;

    // The other chat was left alone, and its processes are the ones it had.
    expect(processesOf(quiet).length, 'the quiet chat lost its processes').toBeGreaterThan(0);

    const row = page.locator(`[data-testid="restore-row"][data-row-key="${greedy}"]`);
    await row.getByTestId('row-name').click();
    await expect(page.getByTestId('chat-loading')).toBeHidden({ timeout: 120_000 });
    await expect(page.getByText(/Your run was stopped because the computer was running out of memory/).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/no answer from the app/)).toHaveCount(0);
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'bw-jb5nf-stopped-for-the-app.png') });

    const sorted = [...health].sort((a, b) => a - b);
    // eslint-disable-next-line no-console
    console.log('MEMORY GUARD:', JSON.stringify({
      stoppedInMs,
      healthChecks: health.length,
      healthFailed: failed,
      healthP90: sorted[Math.floor(sorted.length * 0.9)],
      healthMax: sorted[sorted.length - 1],
    }));
    expect(failed, 'the health check went unanswered').toBe(0);
  } finally {
    for (const pid of greedyChat ? growers(greedyChat) : []) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await project.remove();
  }
});
