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
import { SettingsGroup } from '@/components/settings/section';
import { SettingsScreen, type SettingsSectionDef } from '@/components/settings/settings-screen';
import { TagsSettings } from '@/components/settings/tags-settings';
import { useProjects } from '@/hooks/use-projects';
import { AccountsSettings } from '@/workbench/accounts-settings';
import { DependenciesSettings } from '@/workbench/dependencies-settings';
import { TerminalSettings } from '@/workbench/terminal-settings';

const SECTIONS: SettingsSectionDef[] = [
  { id: 'appearance', label: 'Appearance', hint: 'Theme and type', icon: <Palette /> },
  { id: 'accounts', label: 'Accounts', hint: 'Claude and Codex sign-ins', icon: <Users /> },
  { id: 'files', label: 'Agent files', hint: 'Instructions, settings, skills', icon: <FileCode2 /> },
  { id: 'terminal', label: 'Terminal', hint: 'The shell a terminal opens', icon: <SquareTerminal /> },
  { id: 'dependencies', label: 'Dependencies', hint: 'The tools the app runs', icon: <Puzzle /> },
  { id: 'tags', label: 'Tags', hint: 'Labels for projects', icon: <Tag /> },
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
      const q = next.toString();
      router.push(q ? `/settings?${q}` : '/settings');
    },
    [router, params],
  );

  const known = SECTIONS.some((s) => s.id === section) ? section : null;

  return (
    <SettingsScreen title="Settings" backHref="/" sections={SECTIONS} section={known} onOpen={open}>
      {(known ?? 'appearance') === 'appearance' && <AppearanceSettings />}
      {known === 'accounts' && (
        <SettingsGroup title="Accounts" description="Who each provider runs as. A chat picks one of these when it starts.">
          <div className="p-3">
            <AccountsSettings />
          </div>
        </SettingsGroup>
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
        <SettingsGroup title="Dependencies" description="The command-line tools the app runs on your behalf.">
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
