import { execFileSync, spawn } from 'node:child_process';
import { openSync } from 'node:fs';

/**
 * Killing and restarting the instance under test, by port.
 *
 * ⛔ By port and never by name: another Atelier serves the owner's own board
 * on this machine, and a name-matching kill would take it down with it.
 */

function pidOnPort(port: number): number | null {
  try {
    const out = execFileSync('ss', ['-lntpH', `sport = :${port}`], { encoding: 'utf8' });
    const m = /pid=(\d+)/.exec(out);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return check();
}

/** Stops the server and the sidecar it spawned, then brings both back. */
export async function restartInstance(opts: {
  binary: string;
  serverPort: number;
  sidecarPort: number;
  env: NodeJS.ProcessEnv;
  healthUrl: string;
  logFile: string;
}): Promise<void> {
  for (const port of [opts.serverPort, opts.sidecarPort]) {
    const pid = pidOnPort(port);
    // A SIGTERM to the server does not run the child's drop guard, so the
    // sidecar is stopped explicitly rather than left holding its port.
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
  }
  const freed = await waitFor(() => !pidOnPort(opts.serverPort) && !pidOnPort(opts.sidecarPort), 30_000);
  if (!freed) throw new Error('the instance under test did not stop');

  // The instance that comes back is the one every later assertion is made
  // against, so its output is kept. Discarding it leaves a failure after the
  // restart with no evidence at all.
  const log = openSync(opts.logFile, 'a');
  const child = spawn(opts.binary, [], { env: opts.env, detached: true, stdio: ['ignore', log, log] });
  child.unref();

  const until = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(opts.healthUrl);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > until) throw new Error('the instance under test did not come back');
    await new Promise((r) => setTimeout(r, 250));
  }
}
