/**
 * Whether a chat stopped by a usage limit resumes on its own.
 *
 * One switch, held by the server, which is what watches for the reset and
 * sends the chat `continue` a minute after it (server/src/workbench/limit_resume.rs).
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

import { SettingRow, SettingsGroup } from '@/components/settings/section';
import { ReadFailed } from '@/components/ui/read-failed';
import { Switch } from '@/components/ui/switch';
import { limitSettings, saveLimitSettings, type LimitSettings as Held } from '@/lib/api';

export function LimitSettings() {
  const [held, setHeld] = useState<Held | null>(null);
  const [unread, setUnread] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let gone = false;
    setUnread(null);
    limitSettings()
      .then((it) => !gone && setHeld(it))
      .catch((e) => !gone && setUnread(e instanceof Error ? e.message : String(e)));
    return () => {
      gone = true;
    };
  }, [attempt]);

  const save = useCallback(async (autoResume: boolean) => {
    setRefused(null);
    setSaving(true);
    try {
      setHeld(await saveLimitSettings({ autoResume }));
    } catch (e) {
      setRefused(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, []);

  if (unread) {
    return (
      <ReadFailed
        data-testid="limit-settings-error"
        what="Couldn’t load the usage limit settings."
        why={unread}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }
  if (!held) return null;

  return (
    <SettingsGroup data-testid="limit-settings">
      <SettingRow
        label="Resume automatically"
        description="A chat that hits a usage limit continues one minute after the limit resets."
        htmlFor="limit-auto-resume"
      >
        <Switch
          id="limit-auto-resume"
          data-testid="limit-auto-resume"
          checked={held.autoResume}
          disabled={saving}
          onCheckedChange={(on) => void save(on)}
        />
      </SettingRow>
      {refused && (
        <p data-testid="limit-settings-refused" className="px-3 py-2 text-sm text-danger" role="alert">
          {refused}
        </p>
      )}
    </SettingsGroup>
  );
}
