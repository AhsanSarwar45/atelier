/**
 * The agent a workflow's runs start their chats on (docs/designs/workflows.md):
 * a provider and account, a model and an effort. The editor sets the
 * workflow's own; the Run dialog starts from it and may pick another.
 */
'use client';

import { useEffect, useState } from 'react';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BrandIcon, brandName } from '@/workbench/brand-icon';
import { providerIsAvailable, useProviders } from '@/workbench/providers';
import { SYSTEM_PROFILE, type Brand, type EffortChoice, type ModelChoice, type ProfileChoice } from '@/workbench/protocol';
import { sendCommand } from '@/workbench/use-session';

import { SettingRow } from './section';

export interface WorkflowAgent {
  brand: string;
  profile_id?: string;
  model?: string;
  effort?: string;
}

/** Providers whose chats run on an account. */
const BRANDS: readonly Brand[] = ['claude', 'codex'];
const DEFAULT = 'default';
const NONE = 'none';

function accountKey(agent: WorkflowAgent): string {
  return `${agent.brand}:${agent.profile_id || SYSTEM_PROFILE}`;
}

/** The accounts of every provider, read once per mount. */
function useAccounts(): Partial<Record<Brand, ProfileChoice[]>> {
  const [accounts, setAccounts] = useState<Partial<Record<Brand, ProfileChoice[]>>>({});
  useEffect(() => {
    let gone = false;
    void Promise.all(BRANDS.map(async (brand) => {
      const { profiles } = await sendCommand<{ profiles: ProfileChoice[] }>({ type: 'profiles.list', brand });
      return [brand, profiles] as const;
    }))
      .then((pairs) => { if (!gone) setAccounts(Object.fromEntries(pairs)); })
      .catch(() => {});
    return () => { gone = true; };
  }, []);
  return accounts;
}

/** The models and efforts the chosen account offers. */
function useModels(agent: WorkflowAgent | undefined, projectId: string, projectPath: string) {
  const [offer, setOffer] = useState<{ models: ModelChoice[]; efforts: EffortChoice[] }>({ models: [], efforts: [] });
  const brand = agent?.brand as Brand | undefined;
  const profileId = agent?.profile_id;
  useEffect(() => {
    if (!brand) return;
    let gone = false;
    void sendCommand<{ models: ModelChoice[]; efforts: EffortChoice[] }>({ type: 'workers.models', projectId, projectPath, brand, profileId: profileId ?? null })
      .then((answer) => { if (!gone) setOffer({ models: answer.models ?? [], efforts: answer.efforts ?? [] }); })
      .catch(() => { if (!gone) setOffer({ models: [], efforts: [] }); });
    return () => { gone = true; };
  }, [brand, profileId, projectId, projectPath]);
  return offer;
}

/** Agent, Model and Effort rows. */
export function AgentFields({ agent, onChange, projectId, projectPath, idPrefix }: {
  agent: WorkflowAgent | undefined;
  onChange: (agent: WorkflowAgent | undefined) => void;
  projectId: string;
  projectPath: string;
  idPrefix: string;
}) {
  const providers = useProviders();
  const accounts = useAccounts();
  const { models, efforts } = useModels(agent, projectId, projectPath);

  const options: { value: string; label: string; brand: Brand }[] = [];
  for (const brand of BRANDS) {
    const current = agent?.brand === brand;
    if (!providerIsAvailable(providers, brand) && !current) continue;
    const listed = accounts[brand]?.length ? accounts[brand]! : [{ id: SYSTEM_PROFILE, brand, name: brandName(brand), system: true }];
    for (const profile of listed) {
      options.push({
        value: `${brand}:${profile.id}`,
        label: listed.length > 1 ? `${brandName(brand)} · ${profile.name}` : brandName(brand),
        brand,
      });
    }
  }
  // An account no longer listed still shows, so the choice is never hidden.
  if (agent && !options.some((o) => o.value === accountKey(agent))) {
    options.push({ value: accountKey(agent), label: `${brandName(agent.brand as Brand)} · ${agent.profile_id}`, brand: agent.brand as Brand });
  }
  // A model or effort the account no longer offers still shows by its name.
  const modelOptions = agent?.model && !models.some((m) => m.value === agent.model)
    ? [...models, { value: agent.model, displayName: agent.model } as ModelChoice]
    : models;
  const effortOptions = agent?.effort && !efforts.some((e) => e.value === agent.effort)
    ? [...efforts, { value: agent.effort, displayName: agent.effort } as EffortChoice]
    : efforts;

  return (
    <>
      <SettingRow label="Agent" description="The provider and account each run's chat uses" htmlFor={`${idPrefix}-agent`}>
        <Select
          value={agent ? accountKey(agent) : NONE}
          onValueChange={(value) => {
            if (value === NONE) return onChange(undefined);
            const [brand, profile] = value.split(':');
            onChange({ brand, profile_id: profile === SYSTEM_PROFILE ? undefined : profile });
          }}
        >
          <SelectTrigger id={`${idPrefix}-agent`} aria-label="Agent" className="w-full sm:w-72"><SelectValue placeholder="Choose an agent" /></SelectTrigger>
          <SelectContent>
            {!agent && <SelectItem value={NONE}>Choose an agent</SelectItem>}
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <span className="flex items-center gap-2"><BrandIcon brand={option.brand} className="size-3.5" />{option.label}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      {agent && (
        <>
          <SettingRow label="Model" htmlFor={`${idPrefix}-model`}>
            <Select value={agent.model ?? DEFAULT} onValueChange={(model) => onChange({ ...agent, model: model === DEFAULT ? undefined : model })}>
              <SelectTrigger id={`${idPrefix}-model`} aria-label="Model" className="w-full sm:w-72"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT}>Default</SelectItem>
                {modelOptions.map((m) => <SelectItem key={m.value} value={m.value}>{m.displayName || m.value}</SelectItem>)}
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow label="Effort" htmlFor={`${idPrefix}-effort`}>
            <Select value={agent.effort ?? DEFAULT} onValueChange={(effort) => onChange({ ...agent, effort: effort === DEFAULT ? undefined : effort })}>
              <SelectTrigger id={`${idPrefix}-effort`} aria-label="Effort" className="w-full sm:w-72"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT}>Default</SelectItem>
                {effortOptions.map((e) => <SelectItem key={e.value} value={e.value}>{e.displayName || e.value}</SelectItem>)}
              </SelectContent>
            </Select>
          </SettingRow>
        </>
      )}
    </>
  );
}
