'use client';

/**
 * About: what is running, what is released, and the update between them.
 *
 * Until this existed there was nowhere to see the version at all, and no way
 * to start an update on purpose — the only way one was ever offered was a
 * notice in the corner, which a reader could dismiss and then never find
 * again. Everything the notice can do, this can do, and it is where a skipped
 * version is taken back.
 *
 * How far an update has got is read from `useUpdateRun`, the same hook the
 * notice reads, so the two can never disagree about it.
 */

import { useCallback, useEffect, useState } from 'react';

import { Download, ExternalLink, Loader2, RefreshCw, RotateCcw } from 'lucide-react';

import { SettingsGroup, SettingRow } from '@/components/settings/section';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import * as api from '@/lib/api';
import { howFar, inWords, useUpdateRun, whatTheServerSaid } from '@/lib/update-run';

/** How a version is drawn: never broken across lines in the middle of a number. */
function Version({ children }: { children: React.ReactNode }) {
  return <span className="whitespace-nowrap font-mono tabular-nums">{children}</span>;
}

/** What to call the way this copy was installed. */
const INSTALLED: Record<string, string> = {
  homebrew: 'Installed with Homebrew',
  standalone: 'Installed from a release',
};

export function AboutSettings() {
  const [info, setInfo] = useState<api.VersionCheckResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [skipping, setSkipping] = useState(false);
  const { run, start, busy } = useUpdateRun();

  const look = useCallback(async (refresh: boolean) => {
    setChecking(true);
    setTrouble(null);
    try {
      setInfo(await api.version.check(refresh));
    } catch (why) {
      setTrouble(whatTheServerSaid(why));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void look(false);
  }, [look]);

  /** Skip this version, or take the skip back with null. */
  const skip = useCallback(
    async (version: string | null) => {
      setSkipping(true);
      setTrouble(null);
      try {
        await api.saveUpdateSettings({ skippedVersion: version });
        setInfo((was) => (was ? { ...was, skipped_version: version } : was));
      } catch (why) {
        setTrouble(whatTheServerSaid(why));
      } finally {
        setSkipping(false);
      }
    },
    [],
  );

  const waiting = info?.update_available === true;
  const skipped = info?.skipped_version ?? null;
  const how = info?.install_method ?? null;
  // A Homebrew install upgrades through brew, which needs no release asset of
  // its own. Only a standalone install has to have one built for its platform.
  const canUpdate = how === 'homebrew' || Boolean(info?.asset_url);
  const far = howFar(run);

  return (
    <div data-testid="about-settings">
      <SettingsGroup title="Version">
        <SettingRow label="Atelier" description={how ? INSTALLED[how] : undefined}>
          <Version>v{info?.current ?? '…'}</Version>
        </SettingRow>

        <SettingRow
          label="Latest release"
          description={waiting ? 'An update is ready' : info?.latest ? 'Up to date' : undefined}
          data-testid="about-latest"
        >
          {info?.latest ? (
            <Version>v{info.latest}</Version>
          ) : (
            <span className="text-xs text-t-muted">
              {checking ? 'Checking…' : 'Could not check'}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void look(true)}
            disabled={checking || busy}
            data-testid="about-check"
          >
            {checking ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw aria-hidden="true" />
            )}
            Check now
          </Button>
        </SettingRow>

        {skipped && (
          <SettingRow
            label="Skipped"
            description="You will not be told about this one"
            data-testid="about-skipped"
          >
            <Version>v{skipped}</Version>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void skip(null)}
              disabled={skipping}
              data-testid="about-unskip"
            >
              <RotateCcw aria-hidden="true" />
              Un-skip
            </Button>
          </SettingRow>
        )}
      </SettingsGroup>

      {waiting && (
        <SettingsGroup title={`Update to v${info?.latest}`}>
          <SettingRow
            label="Install the update"
            description={
              canUpdate
                ? how === 'homebrew'
                  ? 'Runs through Homebrew, then restarts'
                  : 'Downloads, checks, then restarts'
                : 'No build for this platform yet'
            }
            stack={run.phase !== 'idle'}
            data-testid="about-update"
          >
            {canUpdate ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void start()}
                disabled={busy}
                data-testid="about-update-now"
              >
                {busy ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <Download aria-hidden="true" />
                )}
                {run.phase === 'failed' ? 'Try again' : busy ? 'Updating…' : 'Update now'}
              </Button>
            ) : (
              info?.download_url && (
                <Button asChild variant="outline" size="sm">
                  <a href={info.download_url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink aria-hidden="true" />
                    Get it from GitHub
                  </a>
                </Button>
              )
            )}
          </SettingRow>

          {run.phase !== 'idle' && (
            <div className="px-3 py-3" data-testid="about-progress">
              {/* A download with no declared size leaves `far` null, and the
                  bar is drawn as moving rather than as a made-up number —
                  which is the truth of a Homebrew upgrade, because brew never
                  says how many bytes it is fetching. */}
              <Progress
                value={far ?? undefined}
                className={far === null && run.phase !== 'failed' ? 'animate-pulse' : undefined}
              />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="min-w-0 break-words text-xs text-t-muted">{inWords(run)}</span>
                {far !== null && (
                  <span className="text-xs tabular-nums text-t-muted">{far}%</span>
                )}
              </div>
            </div>
          )}

          {run.phase === 'failed' && run.failed && (
            <div className="px-3 py-3">
              {/* The server's own words. A checksum that does not match is not
                  a hiccup, and the sentence saying so is the whole message
                  (bw-167m.2). */}
              <p className="break-words text-xs text-destructive" data-testid="about-update-error">
                {run.failed}
              </p>
            </div>
          )}

          {/* Offered unless THIS version is the skipped one. An older version
              sitting in the setting says nothing about the one waiting, and
              hiding the control because of it left no way to skip the release
              actually being offered. */}
          {skipped !== info?.latest && (
            <SettingRow label="Not now" description="Stop being told about this version">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void skip(info?.latest ?? null)}
                disabled={skipping || busy || !info?.latest}
                data-testid="about-skip"
              >
                Skip v{info?.latest}
              </Button>
            </SettingRow>
          )}
        </SettingsGroup>
      )}

      {info?.release_notes && (
        <SettingsGroup
          title="What's new"
          actions={
            info.download_url && (
              <Button asChild variant="dim" size="sm">
                <a href={info.download_url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink aria-hidden="true" />
                  Release
                </a>
              </Button>
            )
          }
        >
          {/* Bounded, because the notes are whatever somebody typed into
              GitHub, and a settings screen is not where a reader should have
              to scroll past one to reach the next control. */}
          <div
            className="max-h-64 overflow-y-auto px-3 py-3 text-xs leading-relaxed text-t-secondary"
            data-testid="about-notes"
          >
            <pre className="whitespace-pre-wrap break-words font-sans">{info.release_notes}</pre>
          </div>
        </SettingsGroup>
      )}

      {trouble && (
        <p className="text-xs text-destructive" data-testid="about-error">
          {trouble}
        </p>
      )}
    </div>
  );
}
