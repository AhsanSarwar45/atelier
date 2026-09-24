"use client";

/**
 * The notice that an update is waiting.
 *
 * It offers three things: take the update, skip this version, or put the
 * notice away for now. Skipping is the one that lasts — it is kept by the
 * server, so the same version stays quiet on the phone as well, and a newer
 * release notifies again (routes/update_settings.rs). Dismissing is only for
 * this page: the notice comes back on the next load, which is what it is for.
 *
 * How far the update has got is read from `useUpdateRun`, the same hook the
 * About section reads, so a bar here cannot disagree with the bar there.
 */

import { useState, useEffect, useCallback } from "react";

import Link from "next/link";

import { Download, RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Panel } from "@/components/ui/panel";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import * as api from "@/lib/api";
import { howFar, inWords, useUpdateRun, whatTheServerSaid } from "@/lib/update-run";

export function UpdateBanner() {
  const [info, setInfo] = useState<api.VersionCheckResponse | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [skipTrouble, setSkipTrouble] = useState<string | null>(null);
  const { run, start, busy } = useUpdateRun();

  useEffect(() => {
    let mounted = true;

    const check = async () => {
      try {
        const data = await api.version.check();
        if (mounted) setInfo(data);
      } catch {
        // Silently ignore — version check is non-critical
      }
    };

    check();
    const interval = setInterval(check, 3600_000); // Re-check every hour
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const skip = useCallback(async () => {
    if (!info?.latest) return;
    setSkipping(true);
    setSkipTrouble(null);
    try {
      await api.saveUpdateSettings({ skippedVersion: info.latest });
      setDismissed(true);
    } catch (why) {
      setSkipTrouble(whatTheServerSaid(why));
    } finally {
      setSkipping(false);
    }
  }, [info?.latest]);

  // A version the reader has already said no to is not news. The server keeps
  // that answer, so this stays quiet on every device rather than only the one
  // the skip was pressed on.
  const skipped = info?.latest != null && info.latest === info.skipped_version;
  if (!info?.update_available || skipped || dismissed) return null;

  const far = howFar(run);
  const canUpdate = info.install_method === "homebrew" || Boolean(info.asset_url);
  const failed = run.phase === "failed";

  return (
    // The library's corner for a lasting notice: below anything that opens
    // over the screen rather than beside it, and pinned to both edges on a
    // phone (bw-81wt.33). Not a toast, which would time out, be swiped away
    // and sit over the dimming — this carries its own controls and progress,
    // and stays until it is answered.
    <Notice>
    <Panel
      tone="overlay"
      inset="none"
      data-testid="update-banner"
      className="border-success/30 p-4"
    >
      {/* The close control is a row item, not something floated over the
          words. It used to be positioned absolutely at `right-2 top-2` with
          only `pr-4` of room reserved for it, so on a phone — where the
          heading wraps — the cross sat on top of the version number. A flex
          sibling cannot overlap its siblings, which is the point of laying it
          out this way rather than widening the padding until it happens to
          clear. */}
      <div className="flex items-start gap-3">
        <Download className="size-5 shrink-0 text-success" aria-hidden="true" />

        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium text-t-primary">
            {/* The version never breaks across lines in the middle of a
                number, however narrow the screen. */}
            Update available:{" "}
            <span className="whitespace-nowrap tabular-nums">v{info.latest}</span>
          </p>
          <p className="text-xs text-t-muted">
            You&apos;re running{" "}
            <span className="whitespace-nowrap tabular-nums">v{info.current}</span>
          </p>

          {failed && run.failed && (
            <p className="mt-1 break-words text-xs text-destructive" data-testid="update-error">
              {run.failed}
            </p>
          )}

          {skipTrouble && (
            <p className="mt-1 break-words text-xs text-destructive" data-testid="update-skip-error">
              {skipTrouble}
            </p>
          )}

          {run.phase !== "idle" && !failed && (
            <div className="pt-1" data-testid="update-progress">
              <Progress
                value={far ?? undefined}
                className={far === null ? "h-1.5 animate-pulse" : "h-1.5"}
              />
              <p className="mt-1 break-words text-xs text-t-muted">{inWords(run)}</p>
            </div>
          )}

          {/* Wraps rather than running off the edge when three controls will
              not sit on one phone-width line. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
            {canUpdate && (
              <Button
                mode="link"
                variant="success"
                size="xs"
                onClick={() => void start()}
                disabled={busy}
              >
                {busy ? (
                  <Spinner size="2xs" />
                ) : (
                  <RefreshCw className="size-3" aria-hidden="true" />
                )}
                {failed ? "Try again" : busy ? inWords(run) : "Update & Restart"}
              </Button>
            )}

            {!busy && (
              <Button
                mode="link"
                variant="dim"
                size="xs"
                onClick={() => void skip()}
                disabled={skipping || !info.latest}
                data-testid="update-skip"
              >
                Skip this version
              </Button>
            )}

            <Button asChild mode="link" variant="dim" underlined="solid" size="xs">
              <Link href="/settings?section=about">Details</Link>
            </Button>
          </div>
        </div>

        <Button
          variant="dim"
          mode="icon"
          size="xs"
          onClick={() => setDismissed(true)}
          className="-mr-1 -mt-1 size-6 shrink-0"
          aria-label="Dismiss"
          disabled={busy}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </Panel>
    </Notice>
  );
}
