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

import { useCallback, useEffect, useRef, useState } from 'react';

import { Check, ExternalLink, Loader2, LogIn, Plus, Trash2, TriangleAlert } from 'lucide-react';

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
import { ReadFailed } from '@/components/ui/read-failed';
import { BrandIcon, brandName } from '@/workbench/brand-icon';
import type { Brand, ProfileChoice, ProfileStanding, SignInProgress } from '@/workbench/protocol';
import { sendCommand } from '@/workbench/use-session';

/** The brands that sign in. `local` runs on this computer and has no account. */
const ACCOUNTED: readonly Brand[] = ['claude', 'codex'];

/** How often a running sign-in is asked how it is getting on. */
const POLL_MS = 1500;

/** Everything known about one brand's accounts. */
interface Held {
  profiles: ProfileChoice[];
  standing: Record<string, ProfileStanding>;
}

/** The sign-in being watched, if one is. */
interface Signing {
  brand: Brand;
  profile: ProfileChoice;
  progress: SignInProgress;
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
  const [signing, setSigning] = useState<Signing | null>(null);
  const [code, setCode] = useState('');
  /** Whether the person said their page handed them a code. */
  const [typing, setTyping] = useState(false);

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

  /** Start a sign-in and watch it. */
  const signIn = useCallback(async (brand: Brand, profile: ProfileChoice) => {
    setRefused(null);
    setCode('');
    setBusy(profile.id);
    try {
      const progress = await sendCommand<SignInProgress>({
        type: 'profile.signin.start',
        brand,
        profileId: profile.id,
      });
      setTyping(false);
      setSigning({ brand, profile, progress });
    } catch (e: unknown) {
      setRefused(said(e));
    } finally {
      setBusy(null);
    }
  }, []);

  // The sign-in happens in a browser tab that is not this one, so there is
  // nothing to wait on here but the answer. Polled rather than streamed: it is
  // one short question, asked while a dialog is open and never otherwise.
  const watching = signing?.progress.state;
  const watchingId = signing?.profile.id;
  const watchingBrand = signing?.brand;
  const done = watching === 'signed-in' || watching === 'failed';
  const settled = useRef(false);
  useEffect(() => {
    if (!watchingId || !watchingBrand || done) return;
    let gone = false;
    const timer = setInterval(() => {
      void sendCommand<SignInProgress>({
        type: 'profile.signin.read',
        brand: watchingBrand,
        profileId: watchingId,
      })
        .then((progress) => {
          if (gone) return;
          setSigning((was) => (was && was.profile.id === watchingId ? { ...was, progress } : was));
        })
        .catch(() => {
          // A sign-in the server has forgotten is not an error to shout
          // about; the dialog already shows the last thing it said.
        });
    }, POLL_MS);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [watchingId, watchingBrand, done]);

  // Once it has ended one way or the other, the list underneath is wrong.
  useEffect(() => {
    if (!done) {
      settled.current = false;
      return;
    }
    if (settled.current) return;
    settled.current = true;
    refresh();
  }, [done, refresh]);

  const close = useCallback(() => {
    if (signing && !done) {
      void sendCommand({
        type: 'profile.signin.cancel',
        brand: signing.brand,
        profileId: signing.profile.id,
      }).catch(() => {});
    }
    setSigning(null);
    setCode('');
    setTyping(false);
  }, [signing, done]);

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

  const hand = useCallback(async () => {
    if (!signing || !code.trim()) return;
    setBusy('code');
    try {
      const progress = await sendCommand<SignInProgress>({
        type: 'profile.signin.paste',
        brand: signing.brand,
        profileId: signing.profile.id,
        code: code.trim(),
      });
      setSigning((was) => (was ? { ...was, progress } : was));
      setCode('');
    } catch (e: unknown) {
      setRefused(said(e));
    } finally {
      setBusy(null);
    }
  }, [signing, code]);

  if (unread) {
    return (
      <ReadFailed
        what="the accounts on this computer"
        why={unread}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }
  if (!held) {
    return <p className="text-sm text-t-muted">Reading the accounts on this computer…</p>;
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
            <ul className="divide-y divide-border rounded-md border border-border">
              {group.profiles.map((profile) => (
                <li
                  key={profile.id}
                  className="flex items-center gap-3 px-3 py-2"
                  data-testid={`account-${brand}-${profile.id}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-t-primary">{profile.name}</p>
                    <p className="truncate text-xs text-t-muted" data-testid={`account-standing-${brand}-${profile.id}`}>
                      {standingWords(group.standing[profile.id])}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
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
          </div>
        );
      })}

      {refused && (
        <p role="alert" className="mt-3 text-sm text-danger" data-testid="accounts-refused">
          {refused}
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

      <Dialog open={signing !== null} onOpenChange={(open) => !open && close()}>
        <DialogContent data-testid="account-signin-dialog">
          <DialogHeader>
            <DialogTitle>
              {signing ? `Sign in to ${signing.profile.name}` : 'Sign in'}
            </DialogTitle>
            {/* Said to a screen reader and not drawn: the buttons below are
                the instruction, and a sentence repeating them is reading
                material on a screen that is meant to be used. */}
            <DialogDescription className="sr-only">
              {signing
                ? `${brandName(signing.brand)} does the signing in. This app never sees your password.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          {signing && <SignInSteps brand={signing.brand} progress={signing.progress} />}
          {/* Claude prints "Paste code here if prompted" the moment it starts,
              and the words that matter are "if prompted": the page signs the
              person in by itself and hands nothing back. Drawing a box for a
              code they will never be shown sends them looking for one. So the
              box is behind a sentence, for the flows that do hand one over —
              an SSO sign-in, or a browser on another machine. */}
          {signing?.progress.state === 'paste-the-code' && !typing && (
            <Button
              type="button"
              variant="foreground"
              size="inherit"
              className="h-auto min-h-0 self-start p-0 text-xs font-normal text-t-muted underline transition-colors hover:text-t-secondary"
              onClick={() => setTyping(true)}
              data-testid="account-signin-has-code"
            >
              That page gave me a code
            </Button>
          )}
          {signing?.progress.state === 'paste-the-code' && typing && (
            <div>
              <div className="flex items-center gap-2">
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void hand();
                  }}
                  placeholder="Paste the code from the page"
                  aria-label="The code the page gave you"
                  className="flex-1 font-mono"
                  data-testid="account-signin-code"
                />
                <Button size="sm" disabled={busy !== null || !code.trim()} onClick={() => void hand()}>
                  Hand it over
                </Button>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={close} data-testid="account-signin-close">
              {done ? 'Done' : 'Cancel'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** What the sign-in is waiting on, in the words for the step it is at. */
function SignInSteps({ brand, progress }: { brand: Brand; progress: SignInProgress }) {
  const [copied, setCopied] = useState(false);
  if (progress.state === 'signed-in') {
    return (
      <p className="flex items-center gap-2 text-sm text-t-primary" data-testid="account-signin-state">
        <Check className="h-4 w-4 text-success" />
        Signed in{progress.standing?.account ? ` as ${progress.standing.account}` : ''}.
      </p>
    );
  }
  if (progress.state === 'failed') {
    return (
      <div data-testid="account-signin-state">
        <p className="flex items-center gap-2 text-sm text-danger">
          <TriangleAlert className="h-4 w-4" />
          That sign-in did not finish.
        </p>
        {/* What the program printed, as it printed it. It is the only party
            that knows what went wrong, and a wording of our own here would be
            a guess drawn over its answer. */}
        {progress.said && (
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2 text-xs text-t-muted">
            {progress.said}
          </pre>
        )}
      </div>
    );
  }
  if (progress.state === 'starting' || !progress.url) {
    return (
      <p className="flex items-center gap-2 text-sm text-t-muted" data-testid="account-signin-state">
        <Loader2 className="h-4 w-4 animate-spin" />
        Starting…
      </p>
    );
  }
  // The address itself is a hundred characters of query string. Printed in
  // full it filled the dialog and told the reader nothing; what they need is
  // somewhere to click, and somewhere to copy from when the browser they want
  // is on a different machine.
  const url = progress.url ?? '';
  return (
    <div className="text-sm" data-testid="account-signin-state">
      <div className="flex items-center gap-2">
        <Button asChild size="sm">
          <a href={url} target="_blank" rel="noreferrer" data-testid="account-signin-url" data-url={url}>
            <ExternalLink className="mr-1 h-3.5 w-3.5" />
            Open the sign-in page
          </a>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(url).then(() => setCopied(true));
          }}
          data-testid="account-signin-copy"
        >
          {copied ? 'Copied' : 'Copy link'}
        </Button>
      </div>
      {progress.code && (
        <>
          <p className="mb-1 mt-4 text-xs text-t-muted">Type this code into that page</p>
          <p className="font-mono text-lg tracking-wide text-t-primary" data-testid="account-signin-onetime">
            {progress.code}
          </p>
        </>
      )}
      <p className="mt-4 flex items-center gap-2 text-xs text-t-muted">
        <Loader2 className="h-3 w-3 animate-spin" />
        {progress.code ? 'Waiting for that code to be entered.' : 'Waiting for that page to finish.'}
      </p>
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
