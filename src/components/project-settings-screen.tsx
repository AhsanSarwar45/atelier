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

import { Archive, ArchiveRestore, FolderSearch, GitBranch, Loader2, NotebookPen, ScrollText, Settings2, ShieldCheck, Tag, Trash2 } from 'lucide-react';

import { AgentFilesBrowser } from '@/components/agent-files-browser';
import { SharedLibrary } from '@/components/settings/shared-library';
import { FolderBrowser } from '@/components/folder-browser';
import { BranchSelect, BranchesPicker } from '@/components/settings/branch-picker';
import { ChatNameEditor } from '@/components/settings/chat-name-editor';
import { ExtensionsPanel } from '@/components/settings/extensions-panel';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import * as api from '@/lib/api';
import type { ChatNamePart, ManifestStorage, ProjectManifest } from '@/lib/api';
import { updateProject } from '@/lib/db';
import { BrandIcon } from '@/workbench/brand-icon';

export const PROJECT_SETTINGS_SECTIONS: SettingsSectionDef[] = [
  { id: 'project', label: 'Project', hint: 'Name, folder', icon: <Settings2 /> },
  { id: 'workflow', label: 'Workflow', hint: 'Cards, branches', icon: <GitBranch /> },
  { id: 'review', label: 'Review', hint: 'Checks', icon: <ShieldCheck /> },
  { id: 'library', label: 'Agent guidance', hint: 'Instructions, skills, commands', icon: <NotebookPen /> },
  { id: 'chat-names', label: 'Chat names', hint: 'Template', icon: <Tag /> },
  { id: 'claude', label: 'Claude Code', hint: 'Project settings', icon: <BrandIcon brand="claude" /> },
  { id: 'codex', label: 'Codex', hint: 'Project settings', icon: <BrandIcon brand="codex" /> },
  { id: 'files', label: 'Agent files', hint: 'Project settings', icon: <ScrollText /> },
];

const commaList = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);

const verificationLines = (value: string): ProjectManifest['verification']['commands'] =>
  value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name = '', command = '', paths = ''] = line.split('|').map((part) => part.trim());
    return { name, command, paths: commaList(paths) };
  });

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
  onTab: (tab: string) => void;
  /** Where the arrow goes when nothing of ours is behind. */
  backHref: string;
  /** How many entries this visit to the settings pushed, so the arrow steps over all of them. */
  backSteps?: number | (() => number);
  onUpdated: () => void;
  /** Called after the project was archived, restored or deleted, so the caller can leave. */
  onGone?: () => void;
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
  backHref,
  backSteps,
  onUpdated,
  onGone,
}: ProjectSettingsScreenProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [name, setName] = useState(projectName);
  const [path, setPath] = useState(projectPath);
  const [localPath, setLocalPath] = useState(projectLocalPath || '');
  const [browsing, setBrowsing] = useState<'path' | 'localPath' | null>(null);
  const [browserPath, setBrowserPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [askingDelete, setAskingDelete] = useState(false);
  const [manifest, setManifest] = useState<ProjectManifest | null>(null);
  const [instructions, setInstructions] = useState('');
  const [savedInstructions, setSavedInstructions] = useState('');
  const [saved, setSaved] = useState<string>('');
  const [beadsAvailable, setBeadsAvailable] = useState(true);
  const [storage, setStorage] = useState<ManifestStorage>('personal');
  const [storedAs, setStoredAs] = useState<ManifestStorage>('personal');
  const [branches, setBranches] = useState<string[]>([]);
  const [claudeLayer, setClaudeLayer] = useState<Layer>('project');
  const isDolt = projectPath.startsWith('dolt://');
  const folder = projectLocalPath || projectPath;

  useEffect(() => {
    setName(projectName);
    setPath(projectPath);
    setLocalPath(projectLocalPath || '');
    api.projects
      .settings(projectId)
      .then((answer) => {
        setBeadsAvailable(answer.beadsAvailable !== false);
        setManifest(answer.manifest);
        setSaved(JSON.stringify(answer.manifest));
        setInstructions(answer.instructions || '');
        setSavedInstructions(answer.instructions || '');
        setStorage(answer.storage);
        setStoredAs(answer.storage);
      })
      .catch(() => setManifest(null));
    if (!folder.startsWith('dolt://')) {
      api.git.branches(folder).then((answer) => setBranches(answer.branches.map((b) => b.name))).catch(() => setBranches([]));
    }
  }, [projectId, projectName, projectPath, projectLocalPath, folder]);

  const dirty =
    name.trim() !== projectName ||
    path.trim() !== projectPath ||
    localPath.trim() !== (projectLocalPath || '') ||
    storage !== storedAs ||
    instructions !== savedInstructions ||
    (manifest !== null && JSON.stringify(manifest) !== saved);

  const save = useCallback(async () => {
    const trimmedName = name.trim();
    const trimmedPath = path.trim().replace(/\\/g, '/');
    const trimmedLocalPath = localPath.trim().replace(/\\/g, '/');
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
        ...(trimmedLocalPath !== (projectLocalPath || '') && { localPath: trimmedLocalPath || undefined }),
      });
      toast({ title: 'Saved' });
      onUpdated();
    } catch (err) {
      toast({ title: 'Not saved', description: err instanceof Error ? err.message : String(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }, [name, path, localPath, manifest, instructions, storage, projectId, projectName, projectPath, projectLocalPath, toast, onUpdated]);

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

  const open = section === 'instructions' ? 'library' : section ?? 'project';
  const projectScope: Scope = useMemo(() => ({ kind: 'project', projectPath: folder }), [folder]);

  const pathField = (label: string, id: string, value: string, onChange: (v: string) => void, key: 'path' | 'localPath') => (
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
      {saving && <Loader2 className="size-4 animate-spin" />} Save
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
        <ProviderTabs brand={brand} tab={known} onOpen={onTab} tabs={tabs}>
          {isPage ? (
            <ProviderSettingsPanel brand={brand} scope={projectScope} page={known} layer={layer} />
          ) : known === 'mcp' ? (
            <McpServersPanel brand={brand} scope={projectScope} />
          ) : known === 'plugins' ? (
            <ExtensionsPanel brand={brand} scope={projectScope} />
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
      section={section === 'instructions' ? 'library' : section}
      onOpen={onOpen}
      wide={open === 'files'}
      bar={dirty || saving ? saveButton : null}
    >
      {open === 'project' && (
        <>
          <SettingsGroup title="Project" data-testid="project-general">
            <SettingRow label="Name" htmlFor="settings-name">
              <Input id="settings-name" value={name} onChange={(e) => setName(e.target.value)} className="w-full sm:w-72" />
            </SettingRow>
            {isDolt ? (
              <>
                <SettingRow label="Dolt source" htmlFor="settings-dolt-source">
                  <Input id="settings-dolt-source" value={path} onChange={(e) => setPath(e.target.value)} className="w-full font-mono text-xs sm:w-72" />
                </SettingRow>
                {pathField('Local folder', 'settings-local-path', localPath, setLocalPath, 'localPath')}
              </>
            ) : (
              pathField('Folder', 'settings-path', path, setPath, 'path')
            )}
            {manifest && (
              <SettingRow label="Settings kept" htmlFor="settings-storage">
                <Select value={storage} onValueChange={(v) => setStorage(v as ManifestStorage)}>
                  <SelectTrigger id="settings-storage" className="w-full sm:w-72">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="personal">On this computer</SelectItem>
                    <SelectItem value="repository" disabled={isDolt && !localPath}>
                      In the repository
                    </SelectItem>
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
            <SettingRow label="Delete" description="From the list only; files and cards stay">
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
                  <AlertDialogDescription>Its cards and files are not touched.</AlertDialogDescription>
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

      {open === 'workflow' && manifest && (
        <SettingsGroup title="Workflow">
          <SettingRow label="Summary" htmlFor="settings-summary" stack>
            <Input id="settings-summary" aria-label="Project summary" value={manifest.project.summary} onChange={(e) => patch('project', { summary: e.target.value })} />
          </SettingRow>
          {beadsAvailable && (
            <SettingRow label="Track work as cards" htmlFor="settings-use-beads">
              <Checkbox id="settings-use-beads" aria-label="Use task tracking for project work" checked={manifest.project.use_beads} onCheckedChange={(c) => patch('project', { use_beads: c === true })} />
            </SettingRow>
          )}
          {beadsAvailable && manifest.project.use_beads && (
            <>
              <SettingRow label="Card prefix" htmlFor="settings-prefix">
                <Input id="settings-prefix" value={manifest.beads.issue_id_prefix} onChange={(e) => patch('beads', { issue_id_prefix: e.target.value })} className="w-40 font-mono text-xs" />
              </SettingRow>
              <SettingRow label="Work areas" htmlFor="settings-areas" description="Comma separated">
                <Input id="settings-areas" value={manifest.beads.work_areas.join(', ')} onChange={(e) => patch('beads', { work_areas: commaList(e.target.value) })} className="w-full sm:w-72" />
              </SettingRow>
              <SettingRow label="Merge into" htmlFor="settings-branch">
                <BranchSelect id="settings-branch" value={manifest.git.completed_work_branch} branches={branches} onChange={(name) => patch('git', { completed_work_branch: name })} testid="settings-branch" />
              </SettingRow>
              <SettingRow label="Agents may merge" htmlFor="settings-merge">
                <Checkbox id="settings-merge" checked={manifest.git.agents_may_merge_completed_work} onCheckedChange={(c) => patch('git', { agents_may_merge_completed_work: c === true })} />
              </SettingRow>
              <SettingRow label="Protected branches" htmlFor="settings-protected">
                <BranchesPicker id="settings-protected" value={manifest.git.protected_branches} branches={branches} onChange={(names) => patch('git', { protected_branches: names })} testid="settings-protected" />
              </SettingRow>
            </>
          )}
          <SettingRow label="Delivery projects" htmlFor="settings-delivery" description="Comma separated">
            <Input id="settings-delivery" value={manifest.cross_project.delivery_projects.join(', ')} onChange={(e) => patch('cross_project', { delivery_projects: commaList(e.target.value) })} className="w-full sm:w-72" />
          </SettingRow>
        </SettingsGroup>
      )}

      {open === 'review' && manifest && (
        <SettingsGroup title="Review">
          <SettingRow label="External review" htmlFor="settings-review">
            <Select value={manifest.review.external_review} onValueChange={(v) => patch('review', { external_review: v as ProjectManifest['review']['external_review'] })}>
              <SelectTrigger id="settings-review" aria-label="External review" className="w-full sm:w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="agent_decides">Agent decides</SelectItem>
                <SelectItem value="always">Always</SelectItem>
                <SelectItem value="never">Never</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow label="Checks" htmlFor="settings-checks" description="name | command | paths" stack>
            <Textarea id="settings-checks" className="min-h-24 font-mono text-xs" value={manifest.verification.commands.map((c) => `${c.name} | ${c.command} | ${(c.paths || []).join(',')}`).join('\n')} onChange={(e) => patch('verification', { commands: verificationLines(e.target.value) })} />
          </SettingRow>
        </SettingsGroup>
      )}


      {open === 'chat-names' && manifest && (
        <SettingsGroup title="Chat names" data-testid="project-chat-names">
          <SettingRow label="Name template" stack>
            <ChatNameEditor
              projectId={projectId}
              parts={manifest.chat_name?.parts ?? []}
              onChange={setChatName}
              prefix={manifest.project.use_beads ? manifest.beads.issue_id_prefix : ''}
            />
          </SettingRow>
        </SettingsGroup>
      )}

      {(open === 'workflow' || open === 'review' || open === 'instructions' || open === 'chat-names') && !manifest && (
        <p className="text-sm text-t-tertiary">No project settings file.</p>
      )}

      {open === 'claude' && provider('claude')}
      {open === 'library' && (folder.startsWith('dolt://') ? <p className="text-sm">Choose a local project folder to configure agent guidance.</p> : manifest ? <SharedLibrary projectPath={folder} projectInstructions={<section aria-label="Project instructions" className="space-y-3"><h3 className="font-semibold">Project instructions</h3><p className="text-sm text-t-secondary">Your shared CLAUDE.md / AGENTS.md guidance. Included in every conversation for this project, across providers. Existing project instructions are preserved here.</p><label className="block"><span className="sr-only">Project instructions</span><Textarea id="settings-instructions" className="min-h-64 font-mono text-sm" value={instructions} onChange={e => setInstructions(e.target.value)} /></label><Button disabled={!dirty || saving} onClick={() => void save()}>Save project instructions</Button></section>} /> : <p className="text-sm">Loading project settings…</p>)}
      {open === 'codex' && provider('codex')}
      {open === 'files' && (
        <div className="-m-4 flex h-[calc(100dvh-3rem)] flex-col sm:-m-6">
          <AgentFilesBrowser projectPath={folder} />
        </div>
      )}
    </SettingsScreen>
  );
}
