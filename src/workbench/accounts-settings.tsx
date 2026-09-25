/**
 * The provider accounts this computer can start a chat on.
 *
 * A person with a work account and a personal one used to have to sign out of
 * one and into the other, because the whole app ran on whichever account the
 * provider's own directory held. An account here is that directory, named:
 * the chat is started with the provider's program pointed at it, so two chats
 * can run on two accounts at the same time (server/src/workbench/profiles.rs).
 *
 * ## Why signing in happens here and not in a terminal
 *
 * It can still happen in a terminal — `CLAUDE_CONFIG_DIR=… claude auth login`
 * is exactly what this runs. But the directory is one this app made and named,
 * so a person who had to find it first would be reading a path out of a
 * settings screen and typing it back into a shell. The app knows the path, so
 * it runs the command.
 *
 * Nothing here ever sees a password or a token. The provider's own program
 * does the signing in, against its own directory, and this shows the link and
 * the code it printed.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

import { LogIn, Pencil, Plus, Star, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Panel } from '@/components/ui/panel';
import { ReadFailed } from '@/components/ui/read-failed';
import { BrandIcon, brandName } from '@/workbench/brand-icon';
import { NO_DEFAULTS, readNewChatDefaults, saveNewChatProfile, type NewChatDefaults } from '@/workbench/new-chat-defaults';
import type { Brand, ProfileChoice, ProfileStanding } from '@/workbench/protocol';
import { useSignIn } from '@/workbench/sign-in-dialog';
import { sendCommand } from '@/workbench/use-session';

/** The brands that sign in. `local` runs on this computer and has no account. */
const ACCOUNTED: readonly Brand[] = ['claude', 'codex'];

/** Everything known about one brand's accounts. */
interface Held {
  profiles: ProfileChoice[];
  standing: Record<string, ProfileStanding>;
}

function said(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function AccountsSettings() {
  const [held, setHeld] = useState<Record<string, Held> | null>(null);
  const [unread, setUnread] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** The brand an account is being named for, if one is. */
  const [naming, setNaming] = useState<Brand | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [defaults, setDefaults] = useState<NewChatDefaults>(NO_DEFAULTS);
  /** The account being renamed, and the name typed so far. */
  const [renaming, setRenaming] = useState<{ brand: Brand; id: string; name: string } | null>(null);

  useEffect(() => {
    readNewChatDefaults().then(setDefaults).catch(() => setDefaults(NO_DEFAULTS));
  }, []);

  const star = useCallback(async (brand: Brand, profileId: string) => {
    setRefused(null);
    try {
      setDefaults(await saveNewChatProfile(brand, profileId));
    } catch (e: unknown) {
      setRefused(said(e));
    }
  }, []);

  const read = useCallback(async () => {
    const next: Record<string, Held> = {};
    for (const brand of ACCOUNTED) {
      const { profiles } = await sendCommand<{ profiles: ProfileChoice[] }>({
        type: 'profiles.list',
        brand,
      });
      const { standing } = await sendCommand<{ standing: Record<string, ProfileStanding> }>({
        type: 'profiles.standing',
        brand,
      });
      next[brand] = { profiles, standing };
    }
    return next;
  }, []);

  useEffect(() => {
    let gone = false;
    setUnread(null);
    read()
      .then((next) => !gone && setHeld(next))
      .catch((e: unknown) => !gone && setUnread(said(e)));
    return () => {
      gone = true;
    };
  }, [read, attempt]);

  const refresh = useCallback(() => {
    read()
      .then(setHeld)
      .catch((e: unknown) => setRefused(said(e)));
  }, [read]);

  // Once it has ended one way or the other, the list underneath is wrong.
  const signing = useSignIn(refresh);
  const signIn = signing.start;

  const add = useCallback(
    async (brand: Brand) => {
      const called = name.trim();
      if (!called) return;
      setRefused(null);
      setBusy(`add-${brand}`);
      try {
        const { profile } = await sendCommand<{ profile: ProfileChoice }>({
          type: 'profile.create',
          brand,
          name: called,
        });
        setName('');
        setNaming(null);
        refresh();
        // An account with nothing signed into it is of no use, so the sign-in
        // follows straight on rather than waiting to be asked for.
        await signIn(brand, profile);
      } catch (e: unknown) {
        setRefused(said(e));
      } finally {
        setBusy(null);
      }
    },
    [name, refresh, signIn],
  );

  const remove = useCallback(
    async (brand: Brand, profile: ProfileChoice) => {
      setRefused(null);
      setBusy(profile.id);
      try {
        await sendCommand({ type: 'profile.delete', brand, profileId: profile.id });
        refresh();
      } catch (e: unknown) {
        setRefused(said(e));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const rename = useCallback(async () => {
    if (!renaming) return;
    const called = renaming.name.trim();
    if (!called) {
      setRenaming(null);
      return;
    }
    setRefused(null);
    setBusy(renaming.id);
    try {
      await sendCommand({ type: 'profile.rename', brand: renaming.brand, profileId: renaming.id, name: called });
      setRenaming(null);
      refresh();
    } catch (e: unknown) {
      setRefused(said(e));
    } finally {
      setBusy(null);
    }
  }, [renaming, refresh]);

  if (unread) {
    return (
      <ReadFailed
        what="Accounts could not be loaded."
        why={unread}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }
  if (!held) {
    return <p className="text-sm text-t-muted">Loading accounts…</p>;
  }

  return (
    <div data-testid="accounts-settings">
      {ACCOUNTED.map((brand) => {
        const group = held[brand];
        if (!group) return null;
        return (
          <div key={brand} className="mb-6 last:mb-0" data-testid={`accounts-${brand}`}>
            <div className="mb-2 flex items-center gap-2">
              <BrandIcon brand={brand} className="h-4 w-4" />
              <h3 className="text-sm font-medium text-t-primary">{brandName(brand)}</h3>
              {/* Beside the name it belongs to, rather than under the list:
                  the name it needs is asked for when it is clicked, so the
                  resting screen is the accounts and nothing else. */}
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                disabled={busy !== null}
                onClick={() => {
                  setName('');
                  setNaming(brand);
                }}
                data-testid={`account-add-${brand}`}
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                Add account
              </Button>
            </div>
            <Panel asChild tone="frame" inset="none" className="divide-y divide-border">
              <ul>
                {group.profiles.map((profile) => (
                  <li
                    key={profile.id}
                    className="flex items-center gap-3 px-3 py-2"
                    data-testid={`account-${brand}-${profile.id}`}
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Open new chats on ${profile.name}`}
                      aria-pressed={(defaults.profiles[brand] ?? 'system') === profile.id}
                      disabled={busy !== null}
                      onClick={() => void star(brand, profile.id)}
                      data-testid={`account-default-${brand}-${profile.id}`}
                    >
                      <Star className={(defaults.profiles[brand] ?? 'system') === profile.id ? 'h-3.5 w-3.5 fill-current text-warning' : 'h-3.5 w-3.5 text-t-muted'} />
                    </Button>
                    <div className="min-w-0 flex-1">
                      {renaming?.brand === brand && renaming.id === profile.id ? (
                        <Input
                          value={renaming.name}
                          autoFocus
                          aria-label="Account name"
                          className="h-7 text-sm"
                          onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void rename();
                            if (e.key === 'Escape') setRenaming(null);
                          }}
                          onBlur={() => void rename()}
                          data-testid={`account-rename-input-${brand}-${profile.id}`}
                        />
                      ) : (
                        <p className="flex items-center gap-1 truncate text-sm text-t-primary">
                          {profile.name}
                          {!profile.system && (
                            <Button
                              variant="ghost"
                              size="2xs"
                              mode="icon"
                              aria-label={`Rename ${profile.name}`}
                              className="text-t-muted"
                              onClick={() => setRenaming({ brand, id: profile.id, name: profile.name })}
                              data-testid={`account-rename-${brand}-${profile.id}`}
                            >
                              <Pencil className="h-3 w-3" />
                            </Button>
                          )}
                        </p>
                      )}
                      <p className="truncate text-xs text-t-muted" data-testid={`account-standing-${brand}-${profile.id}`}>
                        {standingWords(group.standing[profile.id])}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy !== null || signing.busy}
                      onClick={() => void signIn(brand, profile)}
                      data-testid={`account-signin-${brand}-${profile.id}`}
                    >
                      <LogIn className="mr-1 h-3.5 w-3.5" />
                      {group.standing[profile.id]?.signedIn ? 'Sign in again' : 'Sign in'}
                    </Button>
                    {/* The system account is the directory the server booted
                        with. Removing it would delete the login somebody made in
                        a terminal, which this screen did not make and does not
                        get to throw away. */}
                    {!profile.system && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy !== null}
                        aria-label={`Remove ${profile.name}`}
                        onClick={() => void remove(brand, profile)}
                        data-testid={`account-remove-${brand}-${profile.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </li>
                ))}
  </ul>
            </Panel>
          </div>
        );
      })}

      {(refused ?? signing.refused) && (
        <p role="alert" className="mt-3 text-sm text-danger" data-testid="accounts-refused">
          {refused ?? signing.refused}
        </p>
      )}

      <Dialog open={naming !== null} onOpenChange={(open) => !open && setNaming(null)}>
        <DialogContent data-testid="account-new-dialog">
          <DialogHeader>
            <DialogTitle>{naming ? `Add a ${brandName(naming)} account` : 'Add an account'}</DialogTitle>
            <DialogDescription className="sr-only">
              Name the account. Signing in to it follows.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && naming) void add(naming);
            }}
            placeholder="Work, Personal…"
            aria-label="Account name"
            data-testid={naming ? `account-new-${naming}` : 'account-new'}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNaming(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy !== null || !name.trim()}
              onClick={() => naming && void add(naming)}
              data-testid="account-new-confirm"
            >
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {signing.dialog}
    </div>
  );
}

/** What is known about an account, in one line. */
function standingWords(standing: ProfileStanding | undefined): string {
  if (!standing) return 'Not asked yet.';
  if (standing.unknown) return standing.unknown;
  if (!standing.signedIn) return 'Not signed in.';
  // Claude names the account; Codex will only say what it was signed in with,
  // which is a method and not a person (server/src/workbench/signin.rs).
  const who = standing.account
    ? `Signed in as ${standing.account}`
    : standing.how
      ? `Signed in with ${standing.how}`
      : 'Signed in';
  return standing.plan ? `${who} · ${standing.plan}` : `${who}.`;
}
