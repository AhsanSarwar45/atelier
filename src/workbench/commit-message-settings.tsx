/**
 * Which agent writes a commit message when the Git panel is asked for one
 * (bw-7s0up.12).
 *
 * The same shape as the AI search settings beside it: a provider, the account
 * it runs under, a model and an effort, each with a default that means "leave
 * it to the agent".
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

import { AccountPicker, useProfiles } from '@/components/settings/account-picker';
import { CLAUDE_EFFORT, CLAUDE_MODELS, CODEX_EFFORT, CODEX_MODELS } from '@/components/settings/provider-schema';
import { SettingRow, SettingsGroup } from '@/components/settings/section';
import { ReadFailed } from '@/components/ui/read-failed';
import {
  commitMessageSettings,
  saveCommitMessageSettings,
  type CommitMessageSettings as Held,
} from '@/lib/api';
import { SYSTEM_PROFILE } from '@/workbench/protocol';
import { Choose } from '@/workbench/search-settings';

const PROVIDERS = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
];

export function CommitMessageSettings() {
  const [held, setHeld] = useState<Held | null>(null);
  const [unread, setUnread] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let gone = false;
    setUnread(null);
    commitMessageSettings()
      .then((it) => !gone && setHeld(it))
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
        setHeld(await saveCommitMessageSettings({ ...held, ...patch }));
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
        data-testid="commit-message-settings-error"
        what="Couldn’t load Git settings."
        why={unread}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }
  if (!held) return null;

  return (
    <SettingsGroup title="Commit messages" data-testid="commit-message-settings">
      <SettingRow
        label="Provider"
        description="Agent used to generate commit messages"
        htmlFor="commit-message-provider"
      >
        <Choose
          id="commit-message-provider"
          value={held.provider}
          choices={PROVIDERS}
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
      {held.provider && profiles && (
        <SettingRow label="Account" description="Provider account used to generate commit messages">
          <AccountPicker
            brand={brand}
            profiles={profiles}
            value={held.profile}
            onChange={(id) => void save({ profile: id === SYSTEM_PROFILE ? null : id })}
          />
        </SettingRow>
      )}
      {held.provider && (
        <SettingRow
          label="Model"
          description="Model used to generate commit messages"
          htmlFor="commit-message-model"
        >
          <Choose
            id="commit-message-model"
            value={held.model}
            choices={held.provider === 'codex' ? CODEX_MODELS : CLAUDE_MODELS}
            onChange={(model) => void save({ model })}
          />
        </SettingRow>
      )}
      {held.provider && (
        <SettingRow
          label="Effort"
          description="Reasoning used for each commit message"
          htmlFor="commit-message-effort"
        >
          <Choose
            id="commit-message-effort"
            value={held.effort}
            choices={held.provider === 'codex' ? CODEX_EFFORT : CLAUDE_EFFORT}
            onChange={(effort) => void save({ effort })}
          />
        </SettingRow>
      )}
      {refused && (
        <p data-testid="commit-message-settings-refused" className="px-3 py-2 text-sm text-red-500">
          {refused}
        </p>
      )}
    </SettingsGroup>
  );
}
