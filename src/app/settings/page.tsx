/**
 * The settings screen: one screen of sections, the open one named in the
 * address.
 *
 * `/settings?section=<id>` is pushed when a section is pressed, so Back steps
 * between sections and a link opens the one it names. No `section` at all is
 * the list on a phone and the first section on a wide screen (bw-2t1c.2).
 */
'use client';

import { Suspense, useCallback, useMemo } from 'react';

import { useRouter, useSearchParams } from 'next/navigation';

import { Bell, FileCode2, Globe, Info, MemoryStick, Palette, Puzzle, Search, SquareTerminal, Tag, Users } from 'lucide-react';

import { AboutSettings } from '@/components/settings/about-settings';
import { AgentFilesBrowser } from '@/components/agent-files-browser';
import { SharedLibrary } from '@/components/settings/shared-library';
import { useProfiles } from '@/components/settings/account-picker';
import { AppearanceSettings } from '@/components/settings/appearance-settings';
import { NotificationSettings } from '@/components/settings/notification-settings';
import { ProviderSection } from '@/components/settings/provider-section';
import { RemoteAccessSettings } from '@/components/settings/remote-access-settings';
import { SettingsGroup } from '@/components/settings/section';
import { SettingsScreen, type SettingsSectionDef } from '@/components/settings/settings-screen';
import { TagsSettings } from '@/components/settings/tags-settings';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { stepsOut } from '@/lib/address';
import { AccountsSettings } from '@/workbench/accounts-settings';
import { BrandIcon, brandName } from '@/workbench/brand-icon';
import { DependenciesSettings } from '@/workbench/dependencies-settings';
import { SYSTEM_PROFILE } from '@/workbench/protocol';
import { MemorySettings } from '@/workbench/memory-settings';
import { SearchSettings } from '@/workbench/search-settings';
import { TerminalSettings } from '@/workbench/terminal-settings';

const SECTIONS: SettingsSectionDef[] = [
  { id: 'appearance', label: 'Appearance', hint: 'Theme, type', icon: <Palette /> },
  { id: 'notifications', label: 'Notifications', hint: 'Alerts, devices', icon: <Bell /> },
  { id: 'accounts', label: 'Accounts', hint: 'Sign-ins', icon: <Users /> },
  { id: 'library', label: 'Agent guidance', hint: 'Instructions, skills, commands', icon: <FileCode2 /> },
  { id: 'claude', label: 'Claude Code', hint: 'Per account', icon: <BrandIcon brand="claude" /> },
  { id: 'codex', label: 'Codex', hint: 'Per account', icon: <BrandIcon brand="codex" /> },
  { id: 'files', label: 'Agent files', hint: 'Per account', icon: <FileCode2 /> },
  { id: 'search', label: 'Search', hint: 'AI search', icon: <Search /> },
  { id: 'memory', label: 'Memory', hint: 'Chat limit', icon: <MemoryStick /> },
  { id: 'terminal', label: 'Terminal', hint: 'Shell', icon: <SquareTerminal /> },
  { id: 'remote', label: 'Remote access', hint: 'Network access', icon: <Globe /> },
  { id: 'dependencies', label: 'Dependencies', hint: 'Tools', icon: <Puzzle /> },
  { id: 'tags', label: 'Tags', hint: 'Projects', icon: <Tag /> },
  { id: 'about', label: 'About', hint: 'Version, updates', icon: <Info /> },
];

function Settings() {
  const router = useRouter();
  const params = useSearchParams();
  const section = params.get('section');

  const open = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (id) next.set('section', id);
      else next.delete('section');
      // What a section was looking at is that section's, not the next one's.
      next.delete('account');
      next.delete('tab');
      const q = next.toString();
      router.push(q ? `/settings?${q}` : '/settings');
    },
    [router, params],
  );

  const known = SECTIONS.some((s) => s.id === section) ? section : null;
  const account = params.get('account');
  const tab = params.get('tab') ?? 'defaults';
  const claude = useProfiles('claude');
  const codex = useProfiles('codex');
  /** Every account of either provider, for the files section: the system one once, then each named one. */
  const accounts = useMemo(
    () => [
      { id: SYSTEM_PROFILE, label: 'System', brand: undefined },
      ...(claude.profiles ?? []).filter((p) => !p.system).map((p) => ({ id: p.id, label: `${brandName('claude')} · ${p.name}`, brand: 'claude' as const })),
      ...(codex.profiles ?? []).filter((p) => !p.system).map((p) => ({ id: p.id, label: `${brandName('codex')} · ${p.name}`, brand: 'codex' as const })),
    ],
    [claude.profiles, codex.profiles],
  );
  const filesAccount = accounts.find((a) => a.id === (account ?? SYSTEM_PROFILE)) ?? accounts[0];

  /** Changes one part of the address, keeping the rest; pushed so Back undoes it. */
  const set = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (value) next.set(key, value);
      else next.delete(key);
      router.push(`/settings?${next.toString()}`);
    },
    [router, params],
  );

  return (
    <SettingsScreen
      title="Settings"
      backHref="/"
      // Every section and tab pushed an entry; the arrow steps over all of
      // them to the page the reader opened settings from.
      backSteps={() => stepsOut((url) => url.pathname !== '/settings' && !url.pathname.startsWith('/settings/'), 1)}
      sections={SECTIONS}
      section={known}
      onOpen={open}
      wide={known === 'files'}
    >
      {(known ?? 'appearance') === 'appearance' && <AppearanceSettings />}
      {known === 'notifications' && <NotificationSettings />}
      {known === 'library' && <SharedLibrary />}
      {known === 'accounts' && (
        <SettingsGroup title="Accounts">
          <div className="p-3">
            <AccountsSettings />
          </div>
        </SettingsGroup>
      )}
      {(known === 'claude' || known === 'codex') && (
        <ProviderSection
          brand={known}
          account={account}
          tab={tab}
          onAccount={(id) => set('account', id)}
          onTab={(id) => set('tab', id)}
        />
      )}
      {known === 'files' && (
        <div className="-m-4 flex h-[calc(100dvh-3rem)] flex-col sm:-m-6">
          <div className="flex items-center gap-3 px-4 py-2">
            <span className="text-xs font-medium text-t-tertiary">Account</span>
            <Select value={filesAccount.id} onValueChange={(id) => set('account', id === SYSTEM_PROFILE ? null : id)}>
              <SelectTrigger className="w-64" aria-label="Account" data-testid="files-account">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <AgentFilesBrowser profileId={filesAccount.id === SYSTEM_PROFILE ? null : filesAccount.id} brand={filesAccount.brand} />
        </div>
      )}
      {known === 'search' && <SearchSettings />}
      {known === 'memory' && <MemorySettings />}
      {known === 'terminal' && (
        <SettingsGroup title="Terminal">
          <div className="p-3">
            <TerminalSettings />
          </div>
        </SettingsGroup>
      )}
      {known === 'remote' && (
        <RemoteAccessSettings />
      )}
      {known === 'about' && <AboutSettings />}
      {known === 'dependencies' && (
        <SettingsGroup title="Dependencies">
          <div className="p-3">
            <DependenciesSettings />
          </div>
        </SettingsGroup>
      )}
      {known === 'tags' && <TagsSettings />}
    </SettingsScreen>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <Settings />
    </Suspense>
  );
}
