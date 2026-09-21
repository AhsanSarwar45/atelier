"use client";

/**
 * The one reading of what an update is doing.
 *
 * The About section and the corner notice both offer the update and both have
 * to draw how far it has got. They read it from here rather than each keeping
 * their own idea of it, because two readings of one update is how a bar that
 * says 40% ends up beside a label that says restarting.
 *
 * Progress arrives on the window's existing connection, tagged `update`
 * (`workbench/live-wire.ts`). It is not a stream of its own: a browser allows
 * six connections to one address, a stream never gives its slot back, and the
 * app already spent that budget once (bw-zkh4).
 */

import { useCallback, useEffect, useState } from "react";

import * as api from "@/lib/api";
import { onUpdate } from "@/workbench/live-wire";

/**
 * How far an update has got.
 *
 * The order is the order they happen in, and the bar is only meaningful during
 * `downloading` — every later phase is work with no byte count to report
 * (server/src/routes/update_run.rs).
 */
export type UpdatePhase =
  | "idle"
  | "downloading"
  | "verifying"
  | "unpacking"
  | "restarting"
  | "done"
  | "failed";

/** One reading of the running update, as the server sends it. */
export interface UpdateRun {
  phase: UpdatePhase;
  received: number;
  total: number | null;
  note: string | null;
  failed: string | null;
  version: string | null;
}

const NOTHING: UpdateRun = {
  phase: "idle",
  received: 0,
  total: null,
  note: null,
  failed: null,
  version: null,
};

/** What each phase is called on screen. */
const CALLED: Record<UpdatePhase, string> = {
  idle: "",
  downloading: "Downloading",
  verifying: "Checking the download",
  unpacking: "Unpacking",
  restarting: "Restarting",
  done: "Restarting",
  failed: "Update failed",
};

/**
 * What the server said, without the number in front of it.
 *
 * A download can be turned away because the file that arrived is not the one
 * we published, and that sentence is the whole message: it is the difference
 * between "try again later" and "something answered for the download host".
 * `API error: 502` in front of it reads as a hiccup and buries the reason, and
 * the number is the app's business, not the reader's (bw-167m.2).
 */
export function whatTheServerSaid(trouble: unknown): string {
  const said = trouble instanceof Error ? trouble.message : "";
  return said.replace(/^API error: \d+ /, "").trim() || "Update failed";
}

/** A byte count as a person would write it. */
export function inBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  return `${mb.toFixed(1)} MB`;
}

/** Whether an update is under way, and so whether the screen should wait. */
export function running(run: UpdateRun): boolean {
  return (
    run.phase === "downloading" ||
    run.phase === "verifying" ||
    run.phase === "unpacking" ||
    run.phase === "restarting" ||
    run.phase === "done"
  );
}

/**
 * How full the bar is, or null when there is nothing honest to draw.
 *
 * A download with no declared size gets null rather than a made-up number, and
 * the bar reads as indeterminate — which is the truth of a Homebrew upgrade,
 * because brew never says how many bytes it is fetching.
 */
export function howFar(run: UpdateRun): number | null {
  if (run.phase === "done" || run.phase === "restarting") return 100;
  if (run.phase !== "downloading") return null;
  if (!run.total || run.total <= 0) return null;
  return Math.min(100, Math.round((run.received / run.total) * 100));
}

/** What to put under the bar: the phase, and whatever detail there is. */
export function inWords(run: UpdateRun): string {
  const phase = CALLED[run.phase];
  if (run.phase === "downloading" && run.total) {
    return `${phase} — ${inBytes(run.received)} of ${inBytes(run.total)}`;
  }
  if (run.note) return run.note;
  return phase;
}

/**
 * Wait for the server to come back, then draw the new version.
 *
 * The update replaces the program and restarts it, so this page is talking to
 * a process that is about to go. It waits for one that answers, then reloads —
 * and reloads anyway at the end, because a page left saying "restarting"
 * forever is worse than one that reloads onto a server that is still starting.
 */
export async function waitForTheNewOne(): Promise<void> {
  await new Promise((r) => setTimeout(r, 3000));
  for (let i = 0; i < 20; i++) {
    if (await api.reachable("/api/health", 2000)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  window.location.reload();
}

/**
 * The running update, and the way to start one.
 *
 * `start` answers as soon as the update has started; everything after that
 * arrives on the wire. A failure is reported in the server's own words, and
 * leaves the app on the version it was already running, so `start` is also the
 * retry.
 */
export function useUpdateRun(): {
  run: UpdateRun;
  start: () => Promise<void>;
  busy: boolean;
} {
  const [run, setRun] = useState<UpdateRun>(NOTHING);

  useEffect(() => {
    return onUpdate((said) => {
      try {
        setRun(JSON.parse(said) as UpdateRun);
      } catch {
        // A frame we cannot read says nothing about the update, and dropping
        // it leaves the last good reading on screen.
      }
    });
  }, []);

  // The restart is the server going away, which no frame can announce: the
  // connection carrying it is the thing that ends. The page waits for one that
  // answers and then draws the new version.
  useEffect(() => {
    if (run.phase !== "done") return;
    void waitForTheNewOne();
  }, [run.phase]);

  const start = useCallback(async () => {
    // Drawn as started at once. The first frame from the server confirms it,
    // and until then a button that looks untouched invites a second press.
    setRun((was) => ({ ...NOTHING, version: was.version, phase: "downloading" }));
    try {
      const answer = await api.update.perform();
      if (answer.error) {
        setRun((was) => ({ ...was, phase: "failed", failed: answer.error ?? null }));
      }
    } catch (trouble) {
      setRun((was) => ({ ...was, phase: "failed", failed: whatTheServerSaid(trouble) }));
    }
  }, []);

  return { run, start, busy: running(run) };
}
