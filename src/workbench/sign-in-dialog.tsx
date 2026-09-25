/**
 * Signing one provider account in, from wherever the app finds it signed out.
 *
 * The Accounts screen was the only place this could start, so a chat whose
 * login had died said "Internal error: Failed to authenticate" and left the
 * reader to work out that the fix was three screens away. The flow itself —
 * the provider's own program run against the account's own folder, its link
 * and code shown, its answer polled — is the same wherever it starts, so it
 * lives here once and both places draw it (bw-lep5.1).
 *
 * Nothing here ever sees a password or a token. The provider's own program
 * does the signing in, against its own directory, and this shows the link and
 * the code it printed.
 */
'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { Check, ExternalLink, LogIn, TriangleAlert } from 'lucide-react';

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
import { Spinner } from '@/components/ui/spinner';
import { brandName } from '@/workbench/brand-icon';
import type { Brand, ProfileChoice, SignInProgress } from '@/workbench/protocol';
import { sendCommand } from '@/workbench/use-session';

/** How often a running sign-in is asked how it is getting on. */
const POLL_MS = 1500;

/** The sign-in being watched, if one is. */
interface Signing {
  brand: Brand;
  profile: ProfileChoice;
  progress: SignInProgress;
}

function said(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * One account's sign-in: a way to start it, and the dialog that walks it.
 *
 * `onSettled` is told once each attempt ends, signed in or failed, so the
 * screen underneath can read again what it was showing.
 */
export function useSignIn(onSettled?: (outcome: SignInProgress['state']) => void) {
  const [signing, setSigning] = useState<Signing | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [code, setCode] = useState('');
  /** Whether the person said their page handed them a code. */
  const [typing, setTyping] = useState(false);

  /** Start a sign-in and watch it. */
  const start = useCallback(async (brand: Brand, profile: ProfileChoice) => {
    setRefused(null);
    setCode('');
    setBusy(true);
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
      setBusy(false);
    }
  }, []);

  // The sign-in happens in a browser tab that is not this one, so there is
  // nothing to wait on here but the answer. Polled rather than streamed: it is
  // one short question, asked while a dialog is open and never otherwise.
  const watching = signing?.progress.state;
  const watchingId = signing?.profile.id;
  const watchingBrand = signing?.brand;
  const done = watching === 'signed-in' || watching === 'failed';
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

  // Once it has ended one way or the other, whatever was drawn from the old
  // login is wrong.
  const settled = useRef(false);
  const told = useRef(onSettled);
  told.current = onSettled;
  useEffect(() => {
    if (!done) {
      settled.current = false;
      return;
    }
    if (settled.current || !watching) return;
    settled.current = true;
    told.current?.(watching);
  }, [done, watching]);

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

  const hand = useCallback(async () => {
    if (!signing || !code.trim()) return;
    setBusy(true);
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
      setBusy(false);
    }
  }, [signing, code]);

  const dialog = (
    <Dialog open={signing !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent data-testid="account-signin-dialog">
        <DialogHeader>
          <DialogTitle>{signing ? `Sign in to ${signing.profile.name}` : 'Sign in'}</DialogTitle>
          {/* Said to a screen reader and not drawn: the buttons below are
              the instruction, and a sentence repeating them is reading
              material on a screen that is meant to be used. */}
          <DialogDescription className="sr-only">
            {signing
              ? `${brandName(signing.brand)} does the signing in. This app never sees your password.`
              : ''}
          </DialogDescription>
        </DialogHeader>
        {signing && <SignInSteps progress={signing.progress} />}
        {/* Claude prints "Paste code here if prompted" the moment it starts,
            and the words that matter are "if prompted": the page signs the
            person in by itself and hands nothing back. Drawing a box for a
            code they will never be shown sends them looking for one. So the
            box is behind a sentence, for the flows that do hand one over —
            an SSO sign-in, or a browser on another machine. */}
        {signing?.progress.state === 'paste-the-code' && !typing && (
          <Button
            type="button"
            mode="link"
            variant="dim"
            underlined="solid"
            size="sm"
            className="self-start"
            onClick={() => setTyping(true)}
            data-testid="account-signin-has-code"
          >
            Enter a sign-in code
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
                placeholder="Paste sign-in code"
                aria-label="Sign-in code"
                className="flex-1 font-mono"
                data-testid="account-signin-code"
              />
              <Button size="sm" disabled={busy || !code.trim()} onClick={() => void hand()}>
                Submit
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
  );

  return { start, busy, refused, outcome: done ? watching : null, dialog };
}

/** What the sign-in is waiting on, in the words for the step it is at. */
function SignInSteps({ progress }: { progress: SignInProgress }) {
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
          Sign-in failed.
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
        <Spinner />
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
          <p className="mb-1 mt-4 text-xs text-t-muted">Verification code</p>
          <p className="font-mono text-lg tracking-wide text-t-primary" data-testid="account-signin-onetime">
            {progress.code}
          </p>
        </>
      )}
      <p className="mt-4 flex items-center gap-2 text-xs text-t-muted">
        <Spinner size="2xs" />
        {progress.code ? 'Waiting for verification…' : 'Waiting for sign-in…'}
      </p>
    </div>
  );
}

/** A chat's own account, and the sign-in its notice starts. */
export interface ChatAccountSignIn {
  brand: Brand;
  profile: ProfileChoice;
  start: () => void;
  busy: boolean;
  refused: string | null;
  outcome: SignInProgress['state'] | null;
}

/**
 * The account a chat runs on, for a line in its transcript that needs it.
 *
 * Handed down by the chat rather than read by each row: the transcript's rows
 * know what was said, not whose login it was said on. The sign-in itself, and
 * its dialog, belong to the chat and not to the row — the row goes away the
 * moment the account is signed in, and a dialog inside it went with it before
 * it could say so.
 */
export const ChatAccount = createContext<ChatAccountSignIn | null>(null);

/**
 * The sign-in a chat's "Sign in to continue" notice offers, for the account
 * that chat runs on — the same flow the Accounts screen starts.
 */
export function ChatSignIn(): ReactNode {
  const account = useContext(ChatAccount);
  if (!account) return null;
  const { brand, profile, start, busy, refused, outcome } = account;
  return (
    <div className="mt-1.5 pb-1 font-sans" data-testid="chat-signin">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-t-primary" data-testid="chat-signin-said">
          {outcome === 'signed-in'
            ? `Signed in to ${profile.name}. Send your message again to continue.`
            : `The ${brandName(brand)} account “${profile.name}” is signed out. Sign in again to keep going.`}
        </span>
        {outcome !== 'signed-in' && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            disabled={busy}
            onClick={start}
            data-testid="chat-signin-button"
          >
            <LogIn className="mr-1 h-3.5 w-3.5" />
            Sign in to {profile.name}
          </Button>
        )}
      </div>
      {refused && (
        <p role="alert" className="mt-1 text-danger" data-testid="chat-signin-refused">
          {refused}
        </p>
      )}
    </div>
  );
}
