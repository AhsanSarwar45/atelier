/**
 * A project's settings: the same sectioned screen as Settings, over the
 * project, with the section in the address (`&settings=<id>`).
 *
 * Its Claude Code and Codex sections are the provider panels pointed at the
 * project's own files rather than an account's; its Files section is the
 * agent files browser held to this project (bw-2t1c.10).
 */
'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { useRouter } from 'next/navigation';

import { Archive, ArchiveRestore, FolderSearch, NotebookPen, Save, ScrollText, Settings2, Tag, Trash2 } from 'lucide-react';

import { AgentFilesBrowser } from '@/components/agent-files-browser';
import { SharedLibrary } from '@/components/settings/shared-library';
import { DetailHeader, StateDot } from '@/components/settings/library-list';
import { FolderBrowser } from '@/components/folder-browser';
import { ChatNameEditor } from '@/components/settings/chat-name-editor';
import { ExtensionsPanel } from '@/components/settings/extensions-panel';
import { AccountPicker, useProfiles } from '@/components/settings/account-picker';
import { McpServersPanel } from '@/components/settings/mcp-servers-panel';
import { pagesFor, type Brand } from '@/components/settings/provider-schema';
import { ProviderTabs, providerTabs } from '@/components/settings/provider-section';
import type { Layer, Scope } from '@/components/settings/provider-settings-api';
import { ProviderSettingsPanel } from '@/components/settings/provider-settings-panel';
import { SettingRow, SettingsGroup } from '@/components/settings/section';
import { SettingsScreen, type SettingsSectionDef } from '@/components/settings/settings-screen';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/hooks/use-toast';
import * as api from '@/lib/api';
import type { ChatNamePart, ManifestStorage, ProjectManifest } from '@/lib/api';
import { updateProject } from '@/lib/db';
import { BrandIcon } from '@/workbench/brand-icon';
import { readNewChatDefaults } from '@/workbench/new-chat-defaults';

export const PROJECT_SETTINGS_SECTIONS: SettingsSectionDef[] = [
  { id: 'project', label: 'Project', hint: 'Name, folder', icon: <Settings2 /> },
  { id: 'library', label: 'Agent guidance', hint: 'Instructions, skills, commands', icon: <NotebookPen /> },
  { id: 'chat-names', label: 'Chat names', hint: 'Template', icon: <Tag /> },
  { id: 'claude', label: 'Claude Code', hint: 'Project settings', icon: <BrandIcon brand="claude" /> },
  { id: 'codex', label: 'Codex', hint: 'Project settings', icon: <BrandIcon brand="codex" /> },
  { id: 'files', label: 'Agent files', hint: 'Project settings', icon: <ScrollText /> },
];

export interface ProjectSettingsScreenProps {
  projectId: string;
  projectName: string;
  projectPath: string;
  projectLocalPath?: string;
  archivedAt?: string;
  /** The open section, or null for the list on a phone and the first section on a desk. */
  section: string | null;
  /** Which provider tab is open inside a provider section. */
  tab: string | null;
  onOpen: (section: string | null) => void;
  /** Opens a tab, and on it the page of one item, when one is named. */
  onTab: (tab: string, item?: string) => void;
  /** The plugin or server whose page is open on the current tab. */
  item?: string | null;
  onItem?: (item: string | null) => void;
  /** Where the arrow goes when nothing of ours is behind. */
  backHref: string;
  /** How many entries this visit to the settings pushed, so the arrow steps over all of them. */
  backSteps?: number | (() => number);
  onUpdated: () => void;
  /** Called after the project was archived, restored or deleted, so the caller can leave. */
  onGone?: () => void;
}

/**
 * A project's MCP servers as one account's chats get them.
 *
 * Which servers load, whether the folder is trusted and whether a server is
 * signed in all live in the account's own files, so the list is drawn for one
 * account: the one new chats open on, unless another is picked here.
 */
function ProjectMcp({
  brand,
  folder,
  item,
  onItem,
  onPlugin,
}: {
  brand: Brand;
  folder: string;
  item?: string | null;
  onItem?: (item: string | null) => void;
  onPlugin?: (plugin: string) => void;
}) {
  const { profiles } = useProfiles(brand);
  const [chosen, setChosen] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    readNewChatDefaults()
      .then((d) => live && setChosen((c) => c ?? d.profiles[brand] ?? null))
      .catch(() => undefined)
      .finally(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, [brand]);
  const scope: Scope = useMemo(() => ({ kind: 'project', projectPath: folder, profileId: chosen ?? undefined }), [folder, chosen]);
  if (!ready) return <Spinner />;
  return (
    <div className="space-y-4">
      {profiles && profiles.length > 1 && (
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-t-tertiary">Account</span>
          <AccountPicker brand={brand} profiles={profiles} value={chosen} onChange={setChosen} />
        </div>
      )}
      <McpServersPanel brand={brand} scope={scope} item={item} onItem={onItem} onPlugin={onPlugin} />
    </div>
  );
}

export function ProjectSettingsScreen({
  projectId,
  projectName,
  projectPath,
  projectLocalPath,
  archivedAt,
  section,
  tab,
  onOpen,
  onTab,
  item,
  onItem,
  backHref,
  backSteps,
  onUpdated,
  onGone,
}: ProjectSettingsScreenProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [name, setName] = useState(projectName);
  const [path, setPath] = useState(projectPath);
  const [browsing, setBrowsing] = useState<'path' | null>(null);
  const [browserPath, setBrowserPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [askingDelete, setAskingDelete] = useState(false);
  const [manifest, setManifest] = useState<ProjectManifest | null>(null);
  const [instructions, setInstructions] = useState('');
  const [savedInstructions, setSavedInstructions] = useState('');
  const [saved, setSaved] = useState<string>('');
  const [storage, setStorage] = useState<ManifestStorage>('personal');
  const [storedAs, setStoredAs] = useState<ManifestStorage>('personal');
  const [claudeLayer, setClaudeLayer] = useState<Layer>('project');
  const folder = projectLocalPath || projectPath;

  useEffect(() => {
    setName(projectName);
    setPath(projectPath);
    api.projects
      .settings(projectId)
      .then((answer) => {
        setManifest(answer.manifest);
        setSaved(JSON.stringify(answer.manifest));
        setInstructions(answer.instructions || '');
        setSavedInstructions(answer.instructions || '');
        setStorage(answer.storage);
        setStoredAs(answer.storage);
      })
      .catch(() => setManifest(null));
  }, [projectId, projectName, projectPath]);

  const dirty =
    name.trim() !== projectName ||
    path.trim() !== projectPath ||
    storage !== storedAs ||
    instructions !== savedInstructions ||
    (manifest !== null && JSON.stringify(manifest) !== saved);

  const save = useCallback(async () => {
    const trimmedName = name.trim();
    const trimmedPath = path.trim().replace(/\\/g, '/');
    if (!trimmedName) {
      toast({ title: 'Enter a project name', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      if (manifest) {
        const updated = { ...manifest, project: { ...manifest.project, display_name: trimmedName } };
        const answer = await api.projects.updateSettings(projectId, updated, instructions);
        if (answer.storage !== storage) await api.projects.moveSettings(projectId, storage);
        setManifest(updated);
        setSaved(JSON.stringify(updated));
        setInstructions(answer.instructions || '');
        setSavedInstructions(answer.instructions || '');
        setStoredAs(storage);
      }
      await updateProject({
        id: projectId,
        ...(trimmedName !== projectName && { name: trimmedName }),
        ...(trimmedPath !== projectPath && { path: trimmedPath }),
      });
      toast({ title: 'Saved' });
      onUpdated();
    } catch (err) {
      toast({ title: 'Not saved', description: err instanceof Error ? err.message : String(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }, [name, path, manifest, instructions, storage, projectId, projectName, projectPath, toast, onUpdated]);

  const leave = useCallback(
    async (act: () => Promise<void>, done: string) => {
      try {
        await act();
        toast({ title: done });
        onGone?.();
        router.push('/');
      } catch (err) {
        toast({ title: 'Action failed', description: err instanceof Error ? err.message : String(err), variant: 'destructive' });
      }
    },
    [router, toast, onGone],
  );

  const patch = <K extends keyof ProjectManifest>(key: K, value: Partial<ProjectManifest[K]>) =>
    setManifest((m) => (m ? { ...m, [key]: { ...(m[key] as object), ...(value as object) } } : m));

  // An empty template is no template: the key leaves the manifest, so
  // clearing it reads as unchanged from a project that never had one.
  const setChatName = (parts: ChatNamePart[]) =>
    setManifest((m) => {
      if (!m) return m;
      const { chat_name: _dropped, ...rest } = m;
      return parts.length ? { ...rest, chat_name: { parts } } : rest;
    });

  // `workflow` and `review` held the retired board's settings; an old link to
  // either opens the project section, where the summary they shared now lives.
  const shown = section === 'instructions' ? 'library' : section === 'workflow' || section === 'review' ? 'project' : section;
  const open = shown ?? 'project';
  const projectScope: Scope = useMemo(() => ({ kind: 'project', projectPath: folder }), [folder]);

  const pathField = (label: string, id: string, value: string, onChange: (v: string) => void, key: 'path') => (
    <SettingRow label={label} htmlFor={id} stack>
      {browsing === key ? (
        <div className="w-full space-y-2">
          <FolderBrowser
            currentPath={browserPath}
            onPathChange={setBrowserPath}
            onSelectPath={(picked) => {
              onChange(picked);
              setBrowsing(null);
            }}
          />
          <Button type="button" variant="ghost" size="sm" onClick={() => setBrowsing(null)}>
            Type it instead
          </Button>
        </div>
      ) : (
        <div className="flex w-full gap-2">
          <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} className="font-mono text-xs" />
          <Button
            type="button"
            variant="outline"
            size="md"
            aria-label="Browse folders"
            onClick={() => {
              setBrowserPath(value || '');
              setBrowsing(key);
            }}
          >
            <FolderSearch className="size-4" />
          </Button>
        </div>
      )}
    </SettingRow>
  );

  const saveButton = (
    <Button size="sm" className="ml-auto" disabled={!dirty || saving} onClick={() => void save()} data-testid="project-settings-save">
      {saving && <Spinner />} Save
    </Button>
  );

  const provider = (brand: Brand): ReactNode => {
    const tabs = providerTabs(brand, 'project');
    const known = tabs.some((t) => t.id === tab) ? tab! : tabs[0].id;
    const isPage = pagesFor(brand).some((p) => p.id === known);
    const layer: Layer = brand === 'claude' ? claudeLayer : 'project';
    return (
      <div className="space-y-4" data-testid={`project-provider-${brand}`}>
        {brand === 'claude' && (
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-t-tertiary">File</span>
            <Select value={claudeLayer} onValueChange={(v) => setClaudeLayer(v as Layer)}>
              <SelectTrigger className="w-36" aria-label="Which file" data-testid="claude-layer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="project">Shared</SelectItem>
                <SelectItem value="local">Only me</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        <ProviderTabs brand={brand} tab={known} onOpen={(t) => onTab(t)} tabs={tabs}>
          {isPage ? (
            <ProviderSettingsPanel brand={brand} scope={projectScope} page={known} layer={layer} />
          ) : known === 'mcp' ? (
            <ProjectMcp
              brand={brand}
              folder={folder}
              item={item}
              onItem={onItem}
              onPlugin={tabs.some((t) => t.id === 'plugins') ? (p) => onTab('plugins', p) : undefined}
            />
          ) : known === 'plugins' ? (
            <ExtensionsPanel brand={brand} scope={projectScope} item={item} onItem={onItem} onServer={(s) => onTab('mcp', s)} />
          ) : null}
        </ProviderTabs>
      </div>
    );
  };

  return (
    <SettingsScreen
      title={projectName}
      backHref={backHref}
      backSteps={backSteps}
      sections={PROJECT_SETTINGS_SECTIONS}
      section={shown}
      onOpen={onOpen}
      wide={open === 'library'}
      fill={open === 'files'}
      bar={dirty || saving ? saveButton : null}
    >
      {open === 'project' && (
        <>
          <SettingsGroup data-testid="project-general">
            <SettingRow label="Name" htmlFor="settings-name">
              <Input id="settings-name" value={name} onChange={(e) => setName(e.target.value)} className="w-full sm:w-72" />
            </SettingRow>
            {pathField('Folder', 'settings-path', path, setPath, 'path')}
            {manifest && (
              <SettingRow label="Summary" htmlFor="settings-summary" stack>
                <Input id="settings-summary" aria-label="Project summary" value={manifest.project.summary} onChange={(e) => patch('project', { summary: e.target.value })} />
              </SettingRow>
            )}
            {manifest && (
              <SettingRow label="Settings kept" htmlFor="settings-storage">
                <Select value={storage} onValueChange={(v) => setStorage(v as ManifestStorage)}>
                  <SelectTrigger id="settings-storage" className="w-full sm:w-72">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="personal">On this computer</SelectItem>
                    <SelectItem value="repository">In the repository</SelectItem>
                  </SelectContent>
                </Select>
              </SettingRow>
            )}
          </SettingsGroup>
          <SettingsGroup title="Remove" className="mt-6">
            <SettingRow label={archivedAt ? 'Archived' : 'Archive'} description={archivedAt ? undefined : 'Hidden from the list, kept'}>
              {archivedAt ? (
                <Button variant="outline" size="sm" onClick={() => void leave(() => api.projects.unarchive(projectId), 'Restored')}>
                  <ArchiveRestore /> Restore
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => void leave(() => api.projects.archive(projectId), 'Archived')}>
                  <Archive /> Archive
                </Button>
              )}
            </SettingRow>
            <SettingRow label="Delete" description="From the list only; files stay">
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setAskingDelete(true)}
              >
                <Trash2 /> Delete
              </Button>
              <AlertDialog open={askingDelete} onOpenChange={setAskingDelete}>
                <AlertDialogContent>
                  <AlertDialogTitle>Remove this project from the list?</AlertDialogTitle>
                  <AlertDialogDescription>Its files are not touched.</AlertDialogDescription>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void leave(() => api.projects.delete(projectId), 'Removed')}>
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </SettingRow>
          </SettingsGroup>
        </>
      )}

      {open === 'chat-names' && manifest && (
        <SettingsGroup data-testid="project-chat-names">
          <SettingRow label="Name template" stack>
            <ChatNameEditor
              projectId={projectId}
              parts={manifest.chat_name?.parts ?? []}
              onChange={setChatName}
            />
          </SettingRow>
        </SettingsGroup>
      )}

      {open === 'chat-names' && !manifest && (
        <p className="text-sm text-t-tertiary">No project settings file.</p>
      )}

      {open === 'claude' && provider('claude')}
      {open === 'library' && (manifest ? <SharedLibrary projectPath={folder} projectInstructions={<section aria-label="Project instructions" className="min-w-0"><DetailHeader title="Project instructions" meta={<><span className="inline-flex items-center gap-1.5"><StateDot tone="good" />Always active</span><span>Shared by all chats in this project</span></>} actions={<Button size="sm" disabled={!dirty || saving} onClick={() => void save()}><Save className="size-3.5" /><span aria-hidden="true" className="max-sm:hidden">Save</span><span className="sr-only">Save project instructions</span></Button>} /><label className="mt-4 block"><span className="sr-only">Project instructions</span><Textarea id="settings-instructions" className="min-h-[max(24rem,calc(100dvh-22rem))] font-mono text-sm leading-relaxed" value={instructions} onChange={e => setInstructions(e.target.value)} /></label></section>} /> : <p className="text-sm">Loading project settings…</p>)}
      {open === 'codex' && provider('codex')}
      {open === 'files' && (
        <div className="flex h-full flex-col">
          <AgentFilesBrowser projectPath={folder} />
        </div>
      )}
    </SettingsScreen>
  );
}
