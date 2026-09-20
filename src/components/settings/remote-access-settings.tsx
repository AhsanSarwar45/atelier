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
 * ## Why the address is drawn before the switch is on
 *
 * The address is the whole point of this section and the thing a reader wants
 * to know before they commit to anything, so it is drawn as soon as Tailscale
 * has one rather than only once serving is on.
 *
 * Where it came from is carried by the row's shape rather than a sentence
 * under the label: both addresses wear the same address, copy and edit, and
 * the Tailscale one's edit opens the Tailscale admin console because that is
 * where its name is really changed. A line of prose saying the same thing was
 * what the row used to have, and it was the thing that made this screen read
 * as an explanation instead of a setting.
 *
 * ## Why access is two named options and not an address to type
 *
 * It used to be a text box called Listen on, wanting an IP address, with
 * "Every network (0.0.0.0)" as its placeholder. The question underneath it is
 * a real one — the board has no sign-in, so on an office or café network
 * everybody on that Wi-Fi can open it — but almost nobody can answer it in
 * that language, and the two answers that exist are 127.0.0.1 and nothing.
 * Worse, a box that takes any address is a box that can lock a reader out:
 * type it while reading this on your phone, restart, and the board is gone
 * until you find a terminal. So it asks who, in words, and offers the two
 * answers there are (bw-t2m2.3).
 *
 * A stored value that is neither is drawn as itself rather than rounded to
 * whichever door is closer, because guessing on a reader's behalf about who
 * can reach their board is the one place not to guess.
 *
 * The rows are `RadioGroupOption` from the library. Both consequences have to
 * be readable at once, which rules out `Select`, and a screen drawing its own
 * option row is how the app ends up with two that disagree.
 *
 * ## Why one refusal is drawn as a step and not in red
 *
 * Serve is off for an entire Tailscale network until its owner allows it once,
 * and the app is handed the address where they do that. That is not a fault to
 * report, it is the next thing to do, so it is drawn as one — with the link as
 * a link, because a URL inside a red sentence is something to retype.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AddressRow } from '@/components/settings/address-row';
import { SettingRow, SettingsGroup } from '@/components/settings/section';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Panel } from '@/components/ui/panel';
import { RadioGroup, RadioGroupOption } from '@/components/ui/radio-group';
import { ReadFailed } from '@/components/ui/read-failed';
import {
  remoteAccess,
  RemoteAccessRefused,
  restartApp,
  saveRemoteAccess,
  type RemoteAccess,
  type RemoteAccessChange,
} from '@/lib/api';

/** The one command that needs a password, spelled once. */
const INSTALL = 'atelier remote install';

/** What the screen says while a door is being saved, in one place. */
const SAVING = 'Saving…';

/** How long to leave the app to stop and be started again before reloading. */
const RESTART_WAIT_MS = 4000;

/** Where a reader renames the computer the address is made out of. */
const MACHINES = 'https://login.tailscale.com/admin/machines';

/**
 * The two doors, named by what each one lets in.
 *
 * `bindHost` is what the server is told. Empty clears the setting, which is
 * the default and answers on every network this computer is on.
 */
const DOORS = [
  {
    value: 'everyone',
    bindHost: '',
    label: 'Home network and Tailscale',
    means: 'Anyone on your Wi-Fi can open it',
  },
  {
    value: 'here',
    bindHost: '127.0.0.1',
    label: 'Tailscale only',
    means: 'No access from your Wi-Fi',
  },
] as const;

/**
 * The address the next start will answer on, for the line offering a restart.
 *
 * The home address with the saved port swapped into it when that is what
 * changed, so the reader is told the thing they are waiting for rather than
 * that something, somewhere, is pending.
 */
function nextAddress(held: RemoteAccess): string | null {
  if (held.nextPort === null) return null;
  const home = held.homeAddress ?? `http://localhost:${held.port}`;
  return home.replace(/:\d+$/, `:${held.nextPort}`);
}

/** Whether a stored bind address shuts the door on everything but this computer. */
export function shutsTheDoor(bindHost: string | null): boolean {
  return bindHost === '127.0.0.1' || bindHost === '::1' || bindHost === 'localhost';
}

/** A refusal, and anywhere it left to go. */
interface Turned {
  /** What the app said, in its own words. */
  said: string;
  /** Where to go to put it right, when there is such a place. */
  link: string | null;
}

export function RemoteAccessSettings() {
  const [held, setHeld] = useState<RemoteAccess | null>(null);
  const [unread, setUnread] = useState<string | null>(null);
  const [refused, setRefused] = useState<Turned | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const [editingPort, setEditingPort] = useState<string | null>(null);
  const portField = useRef<HTMLInputElement>(null);
  const [restarting, setRestarting] = useState(false);

  const take = useCallback((it: RemoteAccess) => {
    setHeld(it);
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

  // The app answers, then stops. Nothing here can watch it come back over the
  // connection it is about to lose, so the page waits and then goes to where
  // it will be. Where it will be is not always here: a restart asked for
  // because the port changed brings the app back on the new port, and
  // reloading this address would land on the old one, which nothing is
  // listening on any more.
  const restart = useCallback(async () => {
    setRestarting(true);
    setRefused(null);
    try {
      await restartApp();
    } catch (e) {
      setRestarting(false);
      setRefused({
        said: e instanceof Error ? e.message : String(e),
        link: e instanceof RemoteAccessRefused ? e.link : null,
      });
      return;
    }
    const moving = held?.nextPort != null && held.nextPort !== held.port;
    setTimeout(() => {
      if (moving) window.location.port = String(held!.nextPort);
      else window.location.reload();
    }, RESTART_WAIT_MS);
  }, [held]);

  const savePort = useCallback(async () => {
    // Read the field rather than mirroring it in state. It lives for one
    // dialog, it is read once, and a ref is the shorter way to say that.
    const wanted = Number(portField.current?.value);
    if (!Number.isInteger(wanted) || wanted < 1024 || wanted > 65535) {
      setRefused({ said: 'A port is a whole number from 1024 to 65535.', link: null });
      return;
    }
    setEditingPort(null);
    await change({ port: wanted }, SAVING);
  }, [change]);

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
  // A stored address that is neither door checks neither of them. Checking
  // "Home network and Tailscale" would be a claim about who can reach this
  // board, made from a value that says something else; the row above says
  // what it really is instead.
  const openTo = shutsTheDoor(held.bindHost)
    ? 'here'
    : held.bindHost === null || held.bindHost === '0.0.0.0'
      ? 'everyone'
      : undefined;
  // A value from the old text box that is neither door. Saying so beats
  // drawing one of the two as if it were the truth.
  const odd = held.bindHost !== null && !shutsTheDoor(held.bindHost) && held.bindHost !== '0.0.0.0';
  // Only the switch's own wait is drawn on the switch. Choosing a door below
  // is a different wait and says so down there.
  const flipping = saving?.startsWith('Turning') ? saving : null;

  return (
    <SettingsGroup title="Remote access" data-testid="remote-access">
      <SettingRow
        label="Tailscale"
        description="Open Atelier from your own devices"
      >
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
      </SettingRow>

      {flipping && (
        <div className="px-3 py-2">
          <p className="text-xs text-t-muted" role="status" data-testid="remote-working">
            Contacting Tailscale…
          </p>
        </div>
      )}

      {held.wrong && (
        <div className="px-3 py-3">
          <Panel tone="info" inset="md" data-testid="remote-wrong">
            <p className="text-sm text-t-secondary">
              {held.standing === 'not-installed' ? 'Install Tailscale from a terminal' : held.wrong}
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
        </div>
      )}

      {refused?.link && (
        <div className="px-3 py-3">
          <Panel tone="info" inset="md" data-testid="remote-next-step">
            <p className="text-sm text-t-secondary">{refused.said}</p>
            <Button size="sm" variant="outline" className="mt-2" asChild data-testid="remote-next-step-link">
              <a href={refused.link} target="_blank" rel="noreferrer noopener">
                <ExternalLink className="size-4" aria-hidden="true" />
                Open Tailscale
              </a>
            </Button>
          </Panel>
        </div>
      )}

      {refused && !refused.link && (
        <div className="px-3 py-2">
          <p role="alert" className="text-sm text-danger" data-testid="remote-refused">
            {refused.said}
          </p>
        </div>
      )}

      {held.address && (
        <SettingRow label="Tailscale address" stack>
          <AddressRow
            address={held.address}
            editLabel="Rename this computer in Tailscale"
            editHref={MACHINES}
            copied={copied}
            onCopy={copy}
            data-testid="remote-address"
          />
        </SettingRow>
      )}

      {held.homeAddress && (
        <SettingRow label="Home network address" stack>
          <AddressRow
            address={held.homeAddress}
            editLabel="Change the port"
            onEdit={() => setEditingPort(String(held.nextPort ?? held.port))}
            copied={copied}
            onCopy={copy}
            data-testid="remote-home-address"
          />
        </SettingRow>
      )}

      <SettingRow
        label="Access"
        stack
        description={odd ? <span data-testid="remote-host-odd">Currently {held.bindHost}</span> : undefined}
      >
        <RadioGroup
          className="w-full"
          value={openTo}
          disabled={saving !== null}
          onValueChange={(picked) => {
            const door = DOORS.find((it) => it.value === picked);
            if (door) void change({ bindHost: door.bindHost }, SAVING);
          }}
        >
          {DOORS.map((door) => (
            <RadioGroupOption
              key={door.value}
              value={door.value}
              means={door.means}
              data-testid={`remote-reach-${door.value}`}
            >
              {door.label}
            </RadioGroupOption>
          ))}
        </RadioGroup>
      </SettingRow>

      {saving === SAVING && (
        <div className="px-3 py-2">
          <p role="status" className="text-xs text-t-muted" data-testid="remote-reach-saving">
            Saving…
          </p>
        </div>
      )}

      {held.needsRestart && (
        <SettingRow
          label="Restart to apply"
          description={
            held.canRestart
              ? nextAddress(held)
              : `Quit Atelier and start it again${nextAddress(held) ? ` to use ${nextAddress(held)}` : ''}`
          }
          data-testid="remote-restart"
        >
          {held.canRestart && (
            <Button
              size="sm"
              variant="primary"
              disabled={restarting}
              onClick={() => void restart()}
              data-testid="remote-restart-now"
            >
              {restarting && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              {restarting ? 'Restarting…' : 'Restart now'}
            </Button>
          )}
        </SettingRow>
      )}

      <Dialog open={editingPort !== null} onOpenChange={(open) => !open && setEditingPort(null)}>
        <DialogContent className="sm:max-w-sm" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Home network address</DialogTitle>
          </DialogHeader>
          <SettingRow label="Port" stack className="px-0 py-0">
            <Input
              ref={portField}
              type="number"
              min={1024}
              max={65535}
              defaultValue={editingPort ?? ''}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void savePort();
              }}
              aria-label="Port"
              className="font-mono"
              data-testid="remote-port-input"
            />
          </SettingRow>
          <SettingRow
            label="Name"
            description="Run this command in your terminal to change the host name"
            stack
            className="px-0 py-0"
          >
            <AddressRow
              address={held.renameCommand}
              copied={copied}
              onCopy={copy}
              data-testid="remote-rename-command"
            />
          </SettingRow>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setEditingPort(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={() => void savePort()} data-testid="remote-port-save">
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}
