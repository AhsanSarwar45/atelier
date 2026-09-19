/**
 * How the AI search runs: the agent, its account, model and effort, and how
 * long a search may take. Each change is saved as it is made, and the screen
 * redraws from what the server answers (server/src/routes/search_settings.rs).
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

import { AccountPicker, useProfiles } from '@/components/settings/account-picker';
import { CLAUDE_EFFORT, CLAUDE_MODELS, CODEX_EFFORT, CODEX_MODELS } from '@/components/settings/provider-schema';
import { SettingRow, SettingsGroup } from '@/components/settings/section';
import { Input } from '@/components/ui/input';
import { ReadFailed } from '@/components/ui/read-failed';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { saveSearchSettings, searchSettings, type SearchSettings as Held } from '@/lib/api';
import { SYSTEM_PROFILE } from '@/workbench/protocol';

/** The value a Select holds for "nothing chosen", which Radix will not take as "". */
const DEFAULT = '__default__';

const PROVIDERS = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'local', label: 'Local' },
];

const LIMITS = [
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
];

function Choose({
  id,
  value,
  choices,
  onChange,
}: {
  id: string;
  value: string | null;
  choices: { value: string; label: string }[];
  onChange: (value: string | null) => void;
}) {
  const listed = value && !choices.some((c) => c.value === value) ? [...choices, { value, label: value }] : choices;
  return (
    <Select value={value ?? DEFAULT} onValueChange={(v) => onChange(v === DEFAULT ? null : v)}>
      <SelectTrigger id={id} className="w-full sm:w-56" data-testid={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT}>Default</SelectItem>
        {listed.map((choice) => (
          <SelectItem key={choice.value} value={choice.value}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function SearchSettings() {
  const [held, setHeld] = useState<Held | null>(null);
  const [unread, setUnread] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [typedModel, setTypedModel] = useState('');

  useEffect(() => {
    let gone = false;
    setUnread(null);
    searchSettings()
      .then((it) => {
        if (gone) return;
        setHeld(it);
        setTypedModel(it.model ?? '');
      })
      .catch((e) => !gone && setUnread(e instanceof Error ? e.message : String(e)));
    return () => {
      gone = true;
    };
  }, [attempt]);

  const save = useCallback(
    async (patch: Partial<Held>) => {
      if (!held) return;
      setRefused(null);
      try {
        const it = await saveSearchSettings({ ...held, ...patch });
        setHeld(it);
        setTypedModel(it.model ?? '');
      } catch (e) {
        setRefused(e instanceof Error ? e.message : String(e));
      }
    },
    [held],
  );

  const brand = held?.provider === 'codex' ? 'codex' : 'claude';
  const { profiles } = useProfiles(brand);

  if (unread) {
    return (
      <ReadFailed
        data-testid="search-settings-error"
        what="Couldn’t load search settings."
        why={unread}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }
  if (!held) return null;

  const hosted = held.provider === 'claude' || held.provider === 'codex';
  return (
    <SettingsGroup title="AI search" data-testid="search-settings">
      <SettingRow label="Provider" htmlFor="search-provider">
        <Choose
          id="search-provider"
          value={held.provider}
          choices={PROVIDERS}
          // A different agent has different accounts, models and efforts.
          onChange={(provider) =>
            void save({
              provider: provider as Held['provider'],
              profile: null,
              model: null,
              effort: null,
            })
          }
        />
      </SettingRow>
      {hosted && profiles && (
        <SettingRow label="Account">
          <AccountPicker
            brand={brand}
            profiles={profiles}
            value={held.profile}
            onChange={(id) => void save({ profile: id === SYSTEM_PROFILE ? null : id })}
          />
        </SettingRow>
      )}
      {held.provider && (
        <SettingRow label="Model" htmlFor="search-model">
          {hosted ? (
            <Choose
              id="search-model"
              value={held.model}
              choices={held.provider === 'codex' ? CODEX_MODELS : CLAUDE_MODELS}
              onChange={(model) => void save({ model })}
            />
          ) : (
            <Input
              id="search-model"
              data-testid="search-model"
              value={typedModel}
              placeholder="Default"
              className="w-full sm:w-56"
              onChange={(e) => setTypedModel(e.target.value)}
              onBlur={() => typedModel.trim() !== (held.model ?? '') && void save({ model: typedModel.trim() || null })}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          )}
        </SettingRow>
      )}
      {hosted && (
        <SettingRow label="Effort" htmlFor="search-effort">
          <Choose
            id="search-effort"
            value={held.effort}
            choices={held.provider === 'codex' ? CODEX_EFFORT : CLAUDE_EFFORT}
            onChange={(effort) => void save({ effort })}
          />
        </SettingRow>
      )}
      <SettingRow label="Time limit" htmlFor="search-time-limit">
        <Select
          value={String(held.timeLimitSeconds)}
          onValueChange={(seconds) => void save({ timeLimitSeconds: Number(seconds) })}
        >
          <SelectTrigger id="search-time-limit" className="w-full sm:w-56" data-testid="search-time-limit">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(LIMITS.some((l) => l.value === held.timeLimitSeconds)
              ? LIMITS
              : [
                  ...LIMITS,
                  {
                    value: held.timeLimitSeconds,
                    label: `${held.timeLimitSeconds} seconds`,
                  },
                ]
            ).map((limit) => (
              <SelectItem key={limit.value} value={String(limit.value)}>
                {limit.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      {refused && (
        <p data-testid="search-settings-refused" className="px-3 py-2 text-sm text-red-500">
          {refused}
        </p>
      )}
    </SettingsGroup>
  );
}
