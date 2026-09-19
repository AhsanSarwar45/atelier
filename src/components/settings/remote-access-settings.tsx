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
 *
 * ## Why the button says the word and says it is working
 *
 * It used to read On or Off, which is a label for a state and not for what
 * pressing it does, and while the save was in flight it went grey and said
 * nothing at all. Turning this on starts processes and waits on a daemon, so
 * there is a real wait to sit through, and a reader sitting through it in
 * front of a dead grey button has no way to tell working from broken — which
 * is exactly how it was read (bw-ar1o). So the button names the action, and
 * while it is happening it says so.
 *
 * ## Why there is no box for the address
 *
 * There used to be one, called Public URL, sitting right under the Tailscale
 * address. It looked like the place to change that address. It was not: all it
 * changed was a line this app prints in the terminal at startup. A reader
 * typed their own address into it, saved, and watched the address above stay
 * exactly as it was — which is how it was found (bw-t2m2). A box that appears
 * to answer the question a reader actually has, and does not, is worse than no
 * box. The address comes from Tailscale, so the screen says so and links to
 * where it can really be changed. Anybody genuinely running this behind their
 * own domain sets ATELIER_PUBLIC_URL, which is where that reader already was.
 *
 * ## Why one refusal is drawn as a step and not in red
 *
 * Serve is off for an entire Tailscale network until its owner allows it once,
 * and the app is handed the address where they do that. That is not a fault to
 * report, it is the next thing to do, so it is drawn as one — with the link as
 * a link, because a URL inside a red sentence is something to retype.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel } from '@/components/ui/panel';
import { ReadFailed } from '@/components/ui/read-failed';
import {
  remoteAccess,
  RemoteAccessRefused,
  saveRemoteAccess,
  type RemoteAccess,
  type RemoteAccessChange,
} from '@/lib/api';

/** The one command that needs a password, spelled once. */
const INSTALL = 'atelier remote install';

/** A refusal, and anywhere it left to go. */
interface Turned {
  /** What the app said, in its own words. */
  said: string;
  /** Where to go to put it right, when there is such a place. */
  link: string | null;
}

export function RemoteAccessSettings() {
  const [held, setHeld] = useState<RemoteAccess | null>(null);
  const [host, setHost] = useState('');
  const [unread, setUnread] = useState<string | null>(null);
  const [refused, setRefused] = useState<Turned | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);

  const take = useCallback((it: RemoteAccess) => {
    setHeld(it);
    setHost(it.bindHost ?? '');
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
    async (what: RemoteAccessChange, doing: string) => {
      setSaving(doing);
      setRefused(null);
      try {
        take(await saveRemoteAccess(what));
      } catch (e) {
        setRefused({
          said: e instanceof Error ? e.message : String(e),
          link: e instanceof RemoteAccessRefused ? e.link : null,
        });
      } finally {
        setSaving(null);
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
        what="Couldn’t load remote access settings."
        why={unread}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }

  if (!held) {
    return <p className="text-sm text-t-tertiary">Loading remote access…</p>;
  }

  const ready = held.standing === 'ready';
  // Only the switch's own wait is drawn on the switch. A host being saved in
  // the field below is a different wait and says so down there.
  const flipping = saving?.startsWith('Turning') ? saving : null;

  return (
    <div className="space-y-5" data-testid="remote-access">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-t-secondary">Private remote access</p>
            <p className="mt-1 text-sm text-t-tertiary">
              Open Atelier from devices on your Tailscale network.
            </p>
          </div>
          <Button
            size="sm"
            variant={held.serving ? 'outline' : 'primary'}
            disabled={saving !== null || (!ready && !held.serving)}
            aria-pressed={held.serving}
            onClick={() =>
              void change(
                { serving: !held.serving },
                held.serving ? 'Turning it off…' : 'Turning it on…',
              )
            }
            data-testid="remote-serving"
          >
            {flipping && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
            {flipping ? flipping : held.serving ? 'Disable' : 'Enable'}
          </Button>
        </div>

        {flipping && (
          <p
            className="mt-2 flex items-center gap-1.5 text-sm text-t-tertiary"
            role="status"
            data-testid="remote-working"
          >
            Asking Tailscale. This can take a few seconds.
          </p>
        )}

        {held.wrong && (
          <Panel tone="info" inset="md" className="mt-3" data-testid="remote-wrong">
            <p className="text-sm text-t-secondary">
              {held.standing === 'not-installed'
                ? 'Install Tailscale from a terminal:'
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

        {refused?.link && (
          <Panel tone="info" inset="md" className="mt-3" data-testid="remote-next-step">
            <p className="text-sm text-t-secondary">{refused.said}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              asChild
              data-testid="remote-next-step-link"
            >
              <a href={refused.link} target="_blank" rel="noreferrer noopener">
                <ExternalLink className="size-4" aria-hidden="true" />
                Open Tailscale
              </a>
            </Button>
          </Panel>
        )}

        {refused && !refused.link && (
          <p role="alert" className="mt-2 text-sm text-danger" data-testid="remote-refused">
            {refused.said}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="remote-host" className="block text-sm font-medium text-t-secondary">
          Listen on
        </label>
        <p className="mt-1 text-sm text-t-tertiary">
          Leave blank for all networks, or use 127.0.0.1 for this computer only. Applies after restart.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <Input
            id="remote-host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void change({ bindHost: host }, 'Saving…');
            }}
            placeholder={`Every network (${held.bindHostDefault})`}
            autoComplete="off"
            spellCheck={false}
            className="flex-1 font-mono"
          />
          <Button size="sm" disabled={saving !== null} onClick={() => void change({ bindHost: host }, 'Saving…')} data-testid="remote-host-save">
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
