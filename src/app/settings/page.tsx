/**
 * The settings screen: one screen of sections, the open one named in the
 * address.
 *
 * `/settings?section=<id>` is pushed when a section is pressed, so Back steps
 * between sections and a link opens the one it names. No `section` at all is
 * the list on a phone and the first section on a wide screen (bw-2t1c.2).
 */
'use client';

import { Suspense, useCallback } from 'react';

import { useRouter, useSearchParams } from 'next/navigation';

import { FileCode2, Palette, Puzzle, SquareTerminal, Tag, Users } from 'lucide-react';

import { AgentFilesBrowser } from '@/components/agent-files-browser';
import { AppearanceSettings } from '@/components/settings/appearance-settings';
import { ProviderSection } from '@/components/settings/provider-section';
import { SettingsGroup } from '@/components/settings/section';
import { SettingsScreen, type SettingsSectionDef } from '@/components/settings/settings-screen';
import { TagsSettings } from '@/components/settings/tags-settings';
import { useProjects } from '@/hooks/use-projects';
import { AccountsSettings } from '@/workbench/accounts-settings';
import { BrandIcon } from '@/workbench/brand-icon';
import { DependenciesSettings } from '@/workbench/dependencies-settings';
import { TerminalSettings } from '@/workbench/terminal-settings';

const SECTIONS: SettingsSectionDef[] = [
  { id: 'appearance', label: 'Appearance', hint: 'Theme and text', icon: <Palette /> },
  { id: 'accounts', label: 'Accounts', hint: 'Provider accounts', icon: <Users /> },
  { id: 'claude', label: 'Claude Code', hint: 'Defaults and permissions', icon: <BrandIcon brand="claude" /> },
  { id: 'codex', label: 'Codex', hint: 'Defaults and permissions', icon: <BrandIcon brand="codex" /> },
  { id: 'files', label: 'Agent files', hint: 'Instructions and skills', icon: <FileCode2 /> },
  { id: 'terminal', label: 'Terminal', hint: 'Shell settings', icon: <SquareTerminal /> },
  { id: 'dependencies', label: 'Dependencies', hint: 'Required tools', icon: <Puzzle /> },
  { id: 'tags', label: 'Tags', hint: 'Project labels', icon: <Tag /> },
];

function Settings() {
  const router = useRouter();
  const params = useSearchParams();
  const section = params.get('section');
  const { projects } = useProjects();

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
    <SettingsScreen title="Settings" backHref="/" sections={SECTIONS} section={known} onOpen={open}>
      {(known ?? 'appearance') === 'appearance' && <AppearanceSettings />}
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
          <AgentFilesBrowser
            projects={projects
              .filter((project) => !project.archivedAt)
              .map(({ id, name, localPath, path }) => ({ id, name, path: localPath || path }))}
          />
        </div>
      )}
      {known === 'terminal' && (
        <SettingsGroup title="Terminal">
          <div className="p-3">
            <TerminalSettings />
          </div>
        </SettingsGroup>
      )}
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
