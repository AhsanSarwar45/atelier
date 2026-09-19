/**
 * Reaching the board from outside the house, as a switch.
 *
 * The board has no sign-in, so the answer is never a hole in a router: it is a
 * private network only this person's own devices are on. Tailscale is what
 * makes that a switch, and `docs/remote-access.md` says why at length.
 *
 * ## Why one step is still a command
 *
 * Installing Tailscale needs a password, and a web page has nowhere to type
 * one. So that step is `atelier remote install`, printed here to be copied,
 * and it is the only one: that command hands Tailscale to this user, after
 * which the switch below needs nothing.
 *
 * ## Why the standing is drawn as a named step and not as on or off
 *
 * Installed, daemon running, signed in, named, serving — a screen that only
 * said "not working" would leave the reader to find out which of the five it
 * was. The server tells them apart (server/src/remote.rs) and each answers
 * with the one thing to do next, which is what is drawn.
 *
 * ## Why what is drawn comes back from the server after every change
 *
 * The switch reports what Tailscale is doing, not what this screen asked for.
 * A switch drawn on over a board nobody can reach is the one outcome worse
 * than a refusal, so every save redraws from the answer.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

import { Check, Copy } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel } from '@/components/ui/panel';
import { ReadFailed } from '@/components/ui/read-failed';
import { remoteAccess, saveRemoteAccess, type RemoteAccess, type RemoteAccessChange } from '@/lib/api';

/** The one command that needs a password, spelled once. */
const INSTALL = 'atelier remote install';

export function RemoteAccessSettings() {
  const [held, setHeld] = useState<RemoteAccess | null>(null);
  const [host, setHost] = useState('');
  const [url, setUrl] = useState('');
  const [unread, setUnread] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);

  const take = useCallback((it: RemoteAccess) => {
    setHeld(it);
    setHost(it.bindHost ?? '');
    setUrl(it.publicUrl ?? '');
  }, []);

  useEffect(() => {
    let gone = false;
    setUnread(null);
    remoteAccess()
      .then((it) => {
        if (!gone) take(it);
      })
      .catch((e) => {
        if (!gone) setUnread(e instanceof Error ? e.message : String(e));
      });
    return () => {
      gone = true;
    };
  }, [attempt, take]);

  const change = useCallback(
    async (what: RemoteAccessChange) => {
      setSaving(true);
      setRefused(null);
      try {
        take(await saveRemoteAccess(what));
      } catch (e) {
        setRefused(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [take],
  );

  const copy = useCallback((said: string) => {
    void navigator.clipboard?.writeText(said).then(() => {
      setCopied(said);
      setTimeout(() => setCopied((was) => (was === said ? null : was)), 1500);
    });
  }, []);

  if (unread) {
    return (
      <ReadFailed
        data-testid="remote-access-error"
        what="Whether the board can be reached from away could not be read."
        why={unread}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }

  if (!held) {
    return <p className="text-sm text-t-tertiary">Loading the remote access setting…</p>;
  }

  const ready = held.standing === 'ready';

  return (
    <div className="space-y-5" data-testid="remote-access">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-t-secondary">Reach it from anywhere</p>
            <p className="mt-1 text-sm text-t-tertiary">
              Puts the board on your own private network, so your phone opens it from outside the
              house. Nothing is opened to the internet, and speed at home is unchanged.
            </p>
          </div>
          <Button
            size="sm"
            variant={held.serving ? 'primary' : 'outline'}
            disabled={saving || (!ready && !held.serving)}
            aria-pressed={held.serving}
            onClick={() => void change({ serving: !held.serving })}
            data-testid="remote-serving"
          >
            {held.serving ? 'On' : 'Off'}
          </Button>
        </div>

        {held.wrong && (
          <Panel tone="info" inset="md" className="mt-3" data-testid="remote-wrong">
            <p className="text-sm text-t-secondary">
              {held.standing === 'not-installed'
                ? 'Tailscale is not installed. It is the one step that needs a password, so it is run in a terminal:'
                : held.wrong}
            </p>
            {held.standing === 'not-installed' && (
              <div className="mt-2 flex items-center gap-2">
                <Badge asChild variant="secondary" appearance="light" size="sm" className="flex-1 justify-start font-mono">
                  <code>{INSTALL}</code>
                </Badge>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => copy(INSTALL)}
                  aria-label="Copy the install command"
                  data-testid="remote-copy-install"
                >
                  {copied === INSTALL ? <Check className="size-4" /> : <Copy className="size-4" />}
                </Button>
              </div>
            )}
          </Panel>
        )}

        {held.serving && held.address && (
          <div className="mt-3 flex items-center gap-2" data-testid="remote-address">
            <Badge asChild variant="secondary" appearance="light" size="sm" className="flex-1 justify-start font-mono">
              <code>{held.address}</code>
            </Badge>
            <Button
              size="sm"
              variant="outline"
              onClick={() => copy(held.address ?? '')}
              aria-label="Copy the address"
              data-testid="remote-copy-address"
            >
              {copied === held.address ? <Check className="size-4" /> : <Copy className="size-4" />}
            </Button>
          </div>
        )}

        {refused && (
          <p role="alert" className="mt-2 text-sm text-danger" data-testid="remote-refused">
            {refused}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="remote-host" className="block text-sm font-medium text-t-secondary">
          Answer on
        </label>
        <p className="mt-1 text-sm text-t-tertiary">
          Which network the app listens on. Leave it empty to answer on every one, or use
          127.0.0.1 to answer only on this computer. It takes effect the next time the app starts.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <Input
            id="remote-host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void change({ bindHost: host });
            }}
            placeholder={`Every network (${held.bindHostDefault})`}
            autoComplete="off"
            spellCheck={false}
            className="flex-1 font-mono"
          />
          <Button size="sm" disabled={saving} onClick={() => void change({ bindHost: host })} data-testid="remote-host-save">
            Save
          </Button>
        </div>
      </div>

      <div>
        <label htmlFor="remote-url" className="block text-sm font-medium text-t-secondary">
          Tell people to open
        </label>
        <p className="mt-1 text-sm text-t-tertiary">
          The address the app shows first when it starts. Leave it empty and it shows the ones it
          works out on its own.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <Input
            id="remote-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void change({ publicUrl: url });
            }}
            placeholder={held.address ?? 'https://your-computer.tailnet.ts.net'}
            autoComplete="off"
            spellCheck={false}
            className="flex-1 font-mono"
          />
          <Button size="sm" disabled={saving} onClick={() => void change({ publicUrl: url })} data-testid="remote-url-save">
            Save
          </Button>
        </div>
        {held.publishing && (
          <p className="mt-2 text-xs text-t-muted" data-testid="remote-publishing">
            It will say: {held.publishing}
          </p>
        )}
      </div>
    </div>
  );
}
