"use client";

import { useState, useEffect } from "react";

import { Archive, Folder, FolderSearch, Loader2, Trash2 } from "lucide-react";

import { FolderBrowser } from "@/components/folder-browser";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { updateProject } from "@/lib/db";
import * as api from "@/lib/api";
import type { ManifestStorage, ProjectManifest } from "@/lib/api";

interface ProjectSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  projectName: string;
  projectPath: string;
  projectLocalPath?: string;
  archivedAt?: string;
  onUpdated: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
}

const commaList = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);

const verificationLines = (value: string): ProjectManifest['verification']['commands'] =>
  value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name = '', command = '', paths = ''] = line.split('|').map((part) => part.trim());
    return { name, command, paths: commaList(paths) };
  });

export function ProjectSettingsDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
  projectPath,
  projectLocalPath,
  archivedAt,
  onUpdated,
  onArchive,
  onDelete,
}: ProjectSettingsDialogProps) {
  const [name, setName] = useState(projectName);
  const [path, setPath] = useState(projectPath);
  const [localPath, setLocalPath] = useState(projectLocalPath || "");
  const [browsing, setBrowsing] = useState<"path" | "localPath" | null>(null);
  const [browserPath, setBrowserPath] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pathError, setPathError] = useState<string | null>(null);
  const [manifest, setManifest] = useState<ProjectManifest | null>(null);
  const [storage, setStorage] = useState<ManifestStorage>('personal');
  const [branches, setBranches] = useState<string[]>([]);
  const { toast } = useToast();

  const isDolt = projectPath.startsWith("dolt://");

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setName(projectName);
      setPath(projectPath);
      setLocalPath(projectLocalPath || "");
      setBrowsing(null);
      setPathError(null);
      api.projects.settings(projectId).then((answer) => {
        setManifest(answer.manifest);
        setStorage(answer.storage);
      }).catch(() => setManifest(null));
      const gitPath = projectLocalPath || projectPath;
      if (!gitPath.startsWith('dolt://')) {
        api.git.branches(gitPath).then((answer) => setBranches(answer.branches.map((branch) => branch.name))).catch(() => setBranches([]));
      }
    }
  }, [open, projectId, projectName, projectPath, projectLocalPath]);

  const handleBrowseSelect = (selectedPath: string) => {
    if (browsing === "localPath") {
      setLocalPath(selectedPath);
    } else {
      setPath(selectedPath);
    }
    setBrowsing(null);
    setPathError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const trimmedName = name.trim();
    const trimmedPath = path.trim().replace(/\\/g, '/');
    const trimmedLocalPath = localPath.trim().replace(/\\/g, '/');

    if (!trimmedName) {
      toast({
        title: "Invalid name",
        description: "Project name cannot be empty.",
        variant: "destructive",
      });
      return;
    }

    // Nothing changed
    const nameChanged = trimmedName !== projectName;
    const pathChanged = trimmedPath !== projectPath;
    const localPathChanged = trimmedLocalPath !== (projectLocalPath || "");

    if (!nameChanged && !pathChanged && !localPathChanged && !manifest) {
      onOpenChange(false);
      return;
    }

    setIsSubmitting(true);

    try {
      if (manifest) {
        const updated = { ...manifest, project: { ...manifest.project, display_name: trimmedName } };
        const answer = await api.projects.updateSettings(projectId, updated);
        if (answer.storage !== storage) await api.projects.moveSettings(projectId, storage);
      }
      await updateProject({
        id: projectId,
        ...(nameChanged && { name: trimmedName }),
        ...(pathChanged && { path: trimmedPath }),
        ...(localPathChanged && { localPath: trimmedLocalPath || undefined }),
      });

      toast({
        title: "Project updated",
        description: "Settings saved successfully.",
      });

      onOpenChange(false);
      onUpdated();
    } catch (err) {
      console.error("Error updating project:", err);
      toast({
        title: "Settings could not be saved",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderPathField = (
    label: string,
    id: string,
    value: string,
    onChange: (v: string) => void,
    browsingKey: "path" | "localPath",
    placeholder: string,
    hint?: string,
  ) => (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium text-t-secondary">
        {label}
      </label>
      {browsing === browsingKey ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-t-muted">Browse Folders</span>
            <Button
              type="button"
              variant="foreground"
              size="xs"
              onClick={() => setBrowsing(null)}
              className="h-auto min-h-0 p-0 text-xs font-normal text-t-muted transition-colors hover:text-t-secondary"
            >
              Type path instead
            </Button>
          </div>
          <FolderBrowser
            currentPath={browserPath}
            onPathChange={setBrowserPath}
            onSelectPath={(p) => handleBrowseSelect(p)}
          />
        </div>
      ) : (
        <>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Folder className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-t-muted" aria-hidden="true" />
              <Input
                id={id}
                value={value}
                onChange={(e) => {
                  onChange(e.target.value);
                  setPathError(null);
                }}
                placeholder={placeholder}
                className="pl-10"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="md"
              onClick={() => {
                setBrowserPath(value || "");
                setBrowsing(browsingKey);
              }}
              title="Browse folders"
            >
              <FolderSearch className="size-4" />
            </Button>
          </div>
          {pathError && browsingKey === "path" && (
            <p className="text-sm text-danger">{pathError}</p>
          )}
          {hint && <p className="text-xs text-t-muted">{hint}</p>}
        </>
      )}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Project Settings</DialogTitle>
          <DialogDescription>
            Project identity, workflow, verification, review, and local storage.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            {/* Name */}
            <div className="space-y-2">
              <label htmlFor="settings-name" className="text-sm font-medium text-t-secondary">
                Project Name
              </label>
              <Input
                id="settings-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Project"
                autoFocus
              />
            </div>

            {/* Dolt source (editable) */}
            {isDolt && (
              <div className="space-y-2">
                <label htmlFor="settings-dolt-source" className="text-sm font-medium text-t-secondary">
                  Dolt Source
                </label>
                <div className="flex gap-2">
                  <Input
                    id="settings-dolt-source"
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    placeholder="dolt://database_name"
                  />
                  {localPath && (
                    <Button
                      type="button"
                      variant="outline"
                      size="md"
                      onClick={() => {
                        setPath(localPath);
                        setLocalPath("");
                      }}
                    >
                      Clear
                    </Button>
                  )}
                </div>
                <p className="text-xs text-t-muted">
                  {localPath
                    ? "Click Clear to switch from central Dolt server to per-project mode. The project will read its cards from its local .beads/ folder instead."
                    : "Set a Local Folder below first, then Clear will switch the project to per-project Dolt mode."}
                </p>
              </div>
            )}

            {/* Path for filesystem projects */}
            {!isDolt && renderPathField(
              "Project Path",
              "settings-path",
              path,
              setPath,
              "path",
              "/path/to/your/project",
            )}

            {/* Local folder for dolt projects */}
            {isDolt && renderPathField(
              "Local Folder",
              "settings-local-path",
              localPath,
              setLocalPath,
              "localPath",
              "/path/to/your/project",
              !localPath ? "Set a folder path to enable Memory, Agents, and bd CLI." : undefined,
            )}

            {manifest && (
              <div className="grid gap-6 border-t border-b-default pt-5 md:grid-cols-2">
                <section className="space-y-3">
                  <h3 className="font-medium text-t-primary">Workflow</h3>
                  <label className="flex items-center gap-2 text-sm"><Checkbox checked={manifest.project.use_beads} onCheckedChange={(checked) => setManifest({ ...manifest, project: { ...manifest.project, use_beads: checked === true } })} />Use task tracking for project work</label>
                  <label className="block space-y-1 text-sm"><span>Project summary</span><Input value={manifest.project.summary} onChange={(e) => setManifest({ ...manifest, project: { ...manifest.project, summary: e.target.value } })} /></label>
                  {manifest.project.use_beads && <>
                    <label className="block space-y-1 text-sm"><span>Issue ID prefix</span><Input value={manifest.beads.issue_id_prefix} onChange={(e) => setManifest({ ...manifest, beads: { ...manifest.beads, issue_id_prefix: e.target.value } })} /></label>
                    <label className="block space-y-1 text-sm"><span>Completed-work branch</span><Input list="settings-branches" value={manifest.git.completed_work_branch} onChange={(e) => setManifest({ ...manifest, git: { ...manifest.git, completed_work_branch: e.target.value } })} /><datalist id="settings-branches">{branches.map((branch) => <option key={branch} value={branch} />)}</datalist></label>
                    <label className="flex items-center gap-2 text-sm"><Checkbox checked={manifest.git.agents_may_merge_completed_work} onCheckedChange={(checked) => setManifest({ ...manifest, git: { ...manifest.git, agents_may_merge_completed_work: checked === true } })} />Allow agents to merge completed work</label>
                    <label className="block space-y-1 text-sm"><span>Protected branches</span><Input value={manifest.git.protected_branches.join(', ')} onChange={(e) => setManifest({ ...manifest, git: { ...manifest.git, protected_branches: commaList(e.target.value) } })} /></label>
                    <label className="block space-y-1 text-sm"><span>Work areas</span><Input value={manifest.beads.work_areas.join(', ')} onChange={(e) => setManifest({ ...manifest, beads: { ...manifest.beads, work_areas: commaList(e.target.value) } })} /></label>
                  </>}
                </section>

                <section className="space-y-3">
                  <h3 className="font-medium text-t-primary">Review and evidence</h3>
                  <label className="block space-y-1 text-sm"><span>External review</span><Select value={manifest.review.external_review} onValueChange={(value) => setManifest({ ...manifest, review: { ...manifest.review, external_review: value as ProjectManifest['review']['external_review'] } })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="agent_decides">Agent decides</SelectItem><SelectItem value="always">Always</SelectItem><SelectItem value="never">Never</SelectItem></SelectContent></Select></label>
                  <label className="block space-y-1 text-sm"><span>Evidence requirements</span><Input value={manifest.review.evidence_requirements} onChange={(e) => setManifest({ ...manifest, review: { ...manifest.review, evidence_requirements: e.target.value } })} /></label>
                  <label className="flex items-center gap-2 text-sm"><Checkbox checked={manifest.verification.visual_proof_for_ui_changes} onCheckedChange={(checked) => setManifest({ ...manifest, verification: { ...manifest.verification, visual_proof_for_ui_changes: checked === true } })} />Require visual proof for interface changes</label>
                  <label className="block space-y-1 text-sm"><span>Verification commands</span><Textarea className="min-h-24 font-mono text-xs" value={manifest.verification.commands.map((c) => `${c.name} | ${c.command} | ${(c.paths || []).join(',')}`).join('\n')} onChange={(e) => setManifest({ ...manifest, verification: { ...manifest.verification, commands: verificationLines(e.target.value) } })} /></label>
                </section>

                <section className="space-y-3">
                  <h3 className="font-medium text-t-primary">Development</h3>
                  {(['setup_command', 'start_command', 'build_command'] as const).map((key) => <label key={key} className="block space-y-1 text-sm"><span>{key.replace('_', ' ')}</span><Input value={manifest.development[key]} onChange={(e) => setManifest({ ...manifest, development: { ...manifest.development, [key]: e.target.value } })} /></label>)}
                  <label className="block space-y-1 text-sm"><span>Deployment command</span><Input value={manifest.deployment.command} onChange={(e) => setManifest({ ...manifest, deployment: { ...manifest.deployment, command: e.target.value } })} /></label>
                  <label className="flex items-center gap-2 text-sm"><Checkbox checked={manifest.deployment.requires_confirmation} onCheckedChange={(checked) => setManifest({ ...manifest, deployment: { ...manifest.deployment, requires_confirmation: checked === true } })} />Require confirmation before deployment</label>
                </section>

                <section className="space-y-3">
                  <h3 className="font-medium text-t-primary">Storage and related projects</h3>
                  <label className="block space-y-1 text-sm"><span>Project settings location</span><Select value={storage} onValueChange={(value) => setStorage(value as ManifestStorage)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="personal">Only on this computer</SelectItem><SelectItem value="repository" disabled={isDolt && !localPath}>In .atelier/project.toml</SelectItem></SelectContent></Select>{isDolt && !localPath && <span className="text-xs text-t-muted">Repository storage becomes available after a local folder is connected.</span>}</label>
                  <label className="block space-y-1 text-sm"><span>Delivery projects</span><Input value={manifest.cross_project.delivery_projects.join(', ')} onChange={(e) => setManifest({ ...manifest, cross_project: { delivery_projects: commaList(e.target.value) } })} /></label>
                </section>
              </div>
            )}
          </div>

          {!browsing && (
            <>
              {/* Archive/Delete/Save forced a single row at every width, which
                  clipped "Save" off the right edge at 360px with both
                  destructive buttons present (bw-81wt.2) — stack the three
                  full-width below `sm:`, keep the existing row exactly as
                  it was at `sm:` and up. */}
              <DialogFooter className="flex-col items-stretch border-t border-b-default pt-4 mt-4 gap-2 sm:flex-row sm:items-center">
                <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                  {onArchive && !archivedAt && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => { onArchive(); onOpenChange(false); }}
                      className="w-full sm:w-auto"
                    >
                      <Archive className="h-4 w-4" aria-hidden="true" />
                      Archive project
                    </Button>
                  )}
                  {onDelete && (
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => {
                        const confirmed = window.confirm(
                          "Delete this project from the dashboard? Your cards and files will not be affected."
                        );
                        if (confirmed) {
                          onDelete();
                          onOpenChange(false);
                        }
                      }}
                      className="w-full sm:w-auto"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                      Delete project
                    </Button>
                  )}
                </div>
                <Button type="submit" disabled={isSubmitting || !name.trim()} className="w-full sm:w-auto sm:ml-auto">
                  {isSubmitting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      Saving...
                    </>
                  ) : (
                    "Save"
                  )}
                </Button>
              </DialogFooter>
            </>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
