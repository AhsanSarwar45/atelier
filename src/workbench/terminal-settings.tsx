/**
 * Which shell the terminal opens, chosen here.
 *
 * The app opened whatever the system recorded as the login shell, and for
 * someone whose /etc/passwd line still says bash while everything they type
 * runs fish, that is the wrong program every time. So the choice is theirs,
 * and it is made on this screen.
 *
 * ## Why the answer comes from the server and not from this browser
 *
 * The server is what spawns the shell, and the app is opened from more than
 * one machine on the house network - a laptop, a phone. A choice kept in this
 * browser's storage would be a choice the server never hears about, and one
 * that stopped applying the moment the person picked up a different device. So
 * it is read and written over the API, and the server holds it.
 *
 * ## Why a path is typed rather than picked from a menu
 *
 * /etc/shells is a list of the shells the distribution installed, not of the
 * shells that exist. A build in ~/.local/bin is a real shell and will never be
 * on it. So the listed ones are offered as a `datalist` - suggestions the
 * field completes - and anything else typed is still accepted, with the server
 * deciding whether it can be run (server/src/terminal/settings.rs).
 *
 * ## Why a refusal is drawn word for word
 *
 * The server checks the path before it saves anything and answers a bad one
 * with a sentence naming that path. It is the only party that looked at the
 * file, so it is the only one that can say what was wrong with it, and this
 * screen prints what it said rather than a wording of its own.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ReadFailed } from '@/components/ui/read-failed';
import { saveTerminalSettings, terminalSettings, type TerminalShell } from '@/lib/api';

/** The name the field and its suggestions agree on. */
const SUGGESTIONS = 'terminal-shells';

export function TerminalSettings() {
  const [held, setHeld] = useState<TerminalShell | null>(null);
  const [typed, setTyped] = useState('');
  const [unread, setUnread] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let gone = false;
    setUnread(null);
    terminalSettings()
      .then((it) => {
        if (gone) return;
        setHeld(it);
        setTyped(it.shell ?? '');
      })
      .catch((e) => {
        if (gone) return;
        setUnread(e instanceof Error ? e.message : String(e));
      });
    return () => {
      gone = true;
    };
  }, [attempt]);

  /**
   * Sends the choice and redraws from what came back, so what is on the screen
   * is what the server has rather than what this screen hoped it would take.
   * A refusal leaves the field alone: the person is about to correct what they
   * typed, and having it vanish under them would mean typing it again.
   */
  const choose = useCallback(async (shell: string | null) => {
    setSaving(true);
    setRefused(null);
    try {
      const it = await saveTerminalSettings(shell);
      setHeld(it);
      setTyped(it.shell ?? '');
    } catch (e) {
      setRefused(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, []);

  if (unread) {
    return (
      <ReadFailed
        data-testid="terminal-shell-error"
        what="The terminal's shell setting could not be read."
        why={unread}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }

  if (!held) {
    return <p className="text-sm text-t-tertiary">Loading the shell setting…</p>;
  }

  // Empty means nothing chosen, which is a state of its own rather than a path
  // of zero length; the server is told null and deletes what it had.
  const wanted = typed.trim() === '' ? null : typed.trim();

  return (
    <div>
      <label htmlFor="terminal-shell" className="block text-sm font-medium text-t-secondary">
        Shell
      </label>
      <p className="mt-1 text-sm text-t-tertiary">
        The program a terminal tab runs. Leave it empty to open whatever this computer opens on
        its own.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <Input
          id="terminal-shell"
          list={SUGGESTIONS}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void choose(wanted);
          }}
          placeholder={`System default (${held.default})`}
          aria-describedby={refused ? 'terminal-shell-refused' : 'terminal-shell-hint'}
          aria-invalid={refused ? true : undefined}
          autoComplete="off"
          spellCheck={false}
          className="flex-1 font-mono"
        />
        <Button size="sm" disabled={saving} onClick={() => void choose(wanted)}>
          Save
        </Button>
      </div>
      <datalist id={SUGGESTIONS} data-testid="terminal-shells">
        {held.available.map((path) => (
          <option key={path} value={path} />
        ))}
      </datalist>
      {refused && (
        <p
          id="terminal-shell-refused"
          data-testid="terminal-shell-refused"
          role="alert"
          className="mt-2 text-sm text-danger"
        >
          {refused}
        </p>
      )}
      <div className="mt-3 flex items-center justify-between gap-3">
        <p id="terminal-shell-hint" className="text-xs text-t-muted">
          Tabs already open keep the shell they started with. The next tab you open uses this one.
        </p>
        <Button variant="outline" size="sm" disabled={saving} onClick={() => void choose(null)}>
          Use system default
        </Button>
      </div>
    </div>
  );
}
