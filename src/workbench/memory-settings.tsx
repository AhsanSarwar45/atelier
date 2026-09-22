/**
 * How much memory one chat may hold before it is stopped.
 *
 * One number, in gigabytes, counted over everything a chat owns — its
 * provider, its subagents and every shell they start. Empty is no limit, which
 * is how an Atelier nobody has configured runs. A chat that goes over is
 * stopped and restarted with a message naming what it spent
 * (server/src/workbench/memory_limit.rs).
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { SettingRow, SettingsGroup } from '@/components/settings/section';
import { Input } from '@/components/ui/input';
import { ReadFailed } from '@/components/ui/read-failed';
import { memorySettings, saveMemorySettings, type MemorySettings as Held } from '@/lib/api';

/** What the field shows for a limit, so a reload redraws what was typed. */
function typed(held: Held | null): string {
  return held?.limitGb == null ? '' : String(held.limitGb);
}

export function MemorySettings() {
  const [held, setHeld] = useState<Held | null>(null);
  const [unread, setUnread] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState('');
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let gone = false;
    setUnread(null);
    memorySettings()
      .then((it) => {
        if (gone) return;
        setHeld(it);
        setDraft(typed(it));
      })
      .catch((e) => !gone && setUnread(e instanceof Error ? e.message : String(e)));
    return () => {
      gone = true;
    };
  }, [attempt]);

  const save = useCallback(async () => {
    const trimmed = draft.trim();
    const limitGb = trimmed === '' ? null : Number(trimmed);
    if (limitGb !== null && !Number.isFinite(limitGb)) {
      setRefused('A memory limit has to be a number of gigabytes.');
      return;
    }
    if (limitGb === held?.limitGb) {
      setRefused(null);
      return;
    }
    setRefused(null);
    try {
      const it = await saveMemorySettings({ limitGb });
      setHeld(it);
      setDraft(typed(it));
    } catch (e) {
      setRefused(e instanceof Error ? e.message : String(e));
      // What the server still holds is what the field should show.
      setDraft(typed(held));
    }
  }, [draft, held]);

  if (unread) {
    return (
      <ReadFailed
        data-testid="memory-settings-error"
        what="Couldn’t load the memory limit."
        why={unread}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }
  if (!held) return null;

  return (
    <SettingsGroup title="Memory" data-testid="memory-settings">
      <SettingRow
        label="Chat memory limit"
        description="A chat over this is stopped and restarted. Empty is no limit."
        htmlFor="memory-limit"
      >
        <div className="flex items-center gap-2">
          <Input
            ref={field}
            id="memory-limit"
            data-testid="memory-limit"
            type="number"
            min={0.5}
            max={512}
            step={0.5}
            inputMode="decimal"
            placeholder="No limit"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void save()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') field.current?.blur();
            }}
            className="w-28 text-right font-mono"
          />
          <span className="text-sm text-t-tertiary">GB</span>
        </div>
      </SettingRow>
      {refused && (
        <p data-testid="memory-settings-refused" className="px-3 py-2 text-sm text-danger" role="alert">
          {refused}
        </p>
      )}
    </SettingsGroup>
  );
}
