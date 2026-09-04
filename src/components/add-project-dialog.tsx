"use client";

import { useState, useEffect } from "react";

import { Folder, Loader2, FolderSearch, Database, Server } from "lucide-react";

import { FolderBrowser } from "@/components/folder-browser";
import { Badge } from "@/components/ui/badge";
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
import { Panel, panelVariants } from "@/components/ui/panel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import * as api from "@/lib/api";
import type { DoltDatabase, DoltServer, ManifestStorage, ProjectManifest } from "@/lib/api";
import { cn } from "@/lib/utils";


interface AddProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInitialized?: () => Promise<void> | void;
  existingProjectNames?: string[];
}

export function AddProjectDialog({
  open: isOpen,
  onOpenChange,
  onInitialized,
  existingProjectNames = [],
}: AddProjectDialogProps) {
  const [projectPath, setProjectPath] = useState<string>("");
  const [projectName, setProjectName] = useState<string>("");
  const [isValidating, setIsValidating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pathError, setPathError] = useState<string | null>(null);
  const [showNameInput, setShowNameInput] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [browserPath, setBrowserPath] = useState("");
  const [doltDatabases, setDoltDatabases] = useState<DoltDatabase[]>([]);
  const [doltLoading, setDoltLoading] = useState(false);
  const [doltServers, setDoltServers] = useState<DoltServer[]>([]);
  const [serversLoading, setServersLoading] = useState(false);
  const [manifest, setManifest] = useState<ProjectManifest | null>(null);
  // Whether this computer has bd. A board it cannot open is not offered
  // (bw-3tkl.2).
  const [beadsAvailable, setBeadsAvailable] = useState(true);
  const [storage, setStorage] = useState<ManifestStorage>('personal');
  const [branches, setBranches] = useState<string[]>([]);
  const { toast } = useToast();

  // Fetch Dolt databases and per-project servers when dialog opens
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setDoltLoading(true);
    setServersLoading(true);
    api.dolt.databases()
      .then((res) => {
        if (!cancelled) setDoltDatabases(res.databases || []);
      })
      .catch(() => {
        if (!cancelled) setDoltDatabases([]);
      })
      .finally(() => {
        if (!cancelled) setDoltLoading(false);
      });
    api.dolt.servers()
      .then((res) => {
        if (!cancelled) setDoltServers(res.servers || []);
      })
      .catch(() => {
        if (!cancelled) setDoltServers([]);
      })
      .finally(() => {
        if (!cancelled) setServersLoading(false);
      });
    return () => { cancelled = true; };
  }, [isOpen]);

  const resetState = () => {
    setProjectPath("");
    setProjectName("");
    setPathError(null);
    setShowNameInput(false);
    setBrowsing(false);
    setBrowserPath("");
    setIsValidating(false);
    setManifest(null);
    setStorage('personal');
    setBranches([]);
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      resetState();
    }
    onOpenChange(open);
  };

  const validateAndProceed = async (pathToValidate?: string) => {
    const path = pathToValidate || projectPath;
    if (!path.trim()) {
      setPathError("Please enter a project path.");
      return;
    }

    setIsValidating(true);
    setPathError(null);

    try {
      const cleanPath = path.trim().replace(/[/\\]+$/, "");
      const [probe, gitBranches] = await Promise.all([
        api.projects.probe(cleanPath),
        api.git.branches(cleanPath).catch(() => ({ current: '', branches: [] })),
      ]);

      setProjectPath(cleanPath);
      setProjectName(probe.manifest.project.display_name);
      setBeadsAvailable(probe.beadsAvailable !== false);
      setManifest(probe.beadsAvailable === false
        ? { ...probe.manifest, project: { ...probe.manifest.project, use_beads: false } }
        : probe.manifest);
      setStorage(probe.storage ?? 'personal');
      setBranches(gitBranches.branches.map((branch) => branch.name));
      setShowNameInput(true);
      setBrowsing(false);
    } catch (err) {
      console.error("Error validating path:", err);
      const message = err instanceof Error ? err.message : String(err);
      setPathError(message.includes("API error")
        ? "Could not access the specified path. Please check it exists and is on a local drive."
        : "Could not access the specified path. Please check it exists.");
    } finally {
      setIsValidating(false);
    }
  };

  // Filter out databases that are already added as projects
  const existingNamesLower = existingProjectNames.map((n) => n.toLowerCase());
  const newDoltDatabases = doltDatabases.filter(
    (db) => !existingNamesLower.includes(db.project_name.toLowerCase())
  );

  // Filter out per-project servers already added (by folder name or db_name)
  const newDoltServers = doltServers.filter((s) => {
    const folderName = s.project_path ? s.project_path.split(/[/\\]/).pop()?.toLowerCase() : "";
    const dbName = s.db_name?.toLowerCase() || "";
    return !existingNamesLower.includes(folderName || "") &&
      (!dbName || !existingNamesLower.includes(dbName));
  });

  const handleServerQuickAdd = (server: DoltServer) => {
    setProjectPath(server.project_path);
    void validateAndProceed(server.project_path);
  };

  const handleDoltQuickAdd = (db: DoltDatabase) => {
    const source = `dolt://${db.name}`;
    setProjectPath(source);
    void validateAndProceed(source);
  };

  const handleBrowseSelect = (path: string, _hasBeads: boolean) => {
    setProjectPath(path);
    setBrowsing(false);
    validateAndProceed(path);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!projectPath || !projectName.trim() || !manifest) {
      return;
    }

    setIsSubmitting(true);

    try {
      const ready = { ...manifest, project: { ...manifest.project, display_name: projectName.trim() } };
      await api.projects.initialize(projectPath, storage, ready);
      await onInitialized?.();

      toast({
        title: "Project added",
        description: `"${projectName}" has been added successfully.`,
      });

      resetState();
      onOpenChange(false);
    } catch (err) {
      console.error("Error adding project:", err);
      toast({
        title: "Project could not be added",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className={browsing ? "sm:max-w-lg" : (newDoltServers.length > 0 || newDoltDatabases.length > 0) ? "sm:max-w-lg" : "sm:max-w-md"}>
        <DialogHeader>
          <DialogTitle>Add Project</DialogTitle>
          <DialogDescription>
            {showNameInput
              ? "Give your project a name."
              : "Enter the path to a folder with a tracked project in it."}
          </DialogDescription>
        </DialogHeader>

        {!showNameInput ? (
          <div className="flex flex-col gap-4 py-4">
            {/* Per-project Dolt servers discovery */}
            {!browsing && !serversLoading && newDoltServers.length > 0 && (
              <div className="space-y-2">
                <label className="flex items-center gap-1.5 text-sm font-medium text-t-secondary">
                  <Server className="size-3.5" />
                  Per-project Dolt servers
                </label>
                <div className="space-y-1.5">
                  {newDoltServers.map((server) => {
                    const pathParts = server.project_path.split(/[/\\]/);
                    const name = (server.project_path && pathParts[pathParts.length - 1])
                      || server.db_name
                      || `Port ${server.port}`;
                    return (
                      <Button
                        key={`${server.pid}-${server.port}`}
                        type="button"
                        variant="ghost"
                        onClick={() => handleServerQuickAdd(server)}
                        disabled={isSubmitting}
                        className={cn(
                          panelVariants({ inset: 'sm' }),
                          "h-auto w-full justify-between text-left text-sm font-normal",
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <span className="font-medium text-t-primary">{name}</span>
                          <span className="ml-2 truncate text-xs text-t-muted">{server.project_path}</span>
                        </div>
                        <Badge variant="success" appearance="light" size="xs" shape="circle" className="ml-2 shrink-0">
                          :{server.port}
                        </Badge>
                      </Button>
                    );
                  })}
                </div>
                <p className="text-xs text-t-muted">
                  Auto-discovered from running Dolt servers. Choose one to review its project settings.
                </p>
              </div>
            )}
            {/* Dolt central server databases */}
            {!browsing && !doltLoading && newDoltDatabases.length > 0 && (
              <div className="space-y-2">
                <label className="flex items-center gap-1.5 text-sm font-medium text-t-secondary">
                  <Database className="size-3.5" />
                  Found in Dolt
                </label>
                <div className="flex flex-wrap gap-2">
                  {newDoltDatabases.map((db) => (
                    <Button
                      key={db.name}
                      type="button"
                      variant="ghost"
                      onClick={() => handleDoltQuickAdd(db)}
                      disabled={isSubmitting}
                      className={cn(panelVariants({ inset: 'sm' }), "h-auto gap-1.5 py-1.5 text-sm font-normal")}
                    >
                      {db.project_name}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-t-muted">
                  Choose one to review its project settings. Memory and Agents still require a local folder.
                </p>
              </div>
            )}
            {browsing ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-t-secondary">
                    Browse Folders
                  </label>
                  <Button
                    type="button"
                    variant="dim"
                    size="xs"
                    onClick={() => setBrowsing(false)}
                  >
                    Type path instead
                  </Button>
                </div>
                <FolderBrowser
                  currentPath={browserPath}
                  onPathChange={setBrowserPath}
                  onSelectPath={handleBrowseSelect}
                />
              </div>
            ) : (
              <div className="space-y-2">
                <label htmlFor="path" className="text-sm font-medium text-t-secondary">
                  Project Path
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Folder className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-t-muted" aria-hidden="true" />
                    <Input
                      id="path"
                      value={projectPath}
                      onChange={(e) => {
                        setProjectPath(e.target.value);
                        setPathError(null);
                      }}
                      placeholder="/path/to/your/project"
                      className="pl-10"
                      autoFocus
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="md"
                    onClick={() => setBrowsing(true)}
                    title="Browse folders"
                  >
                    <FolderSearch className="size-4" />
                    Browse
                  </Button>
                </div>
                {pathError && (
                  <p className="text-sm text-danger">{pathError}</p>
                )}
                <p className="text-xs text-t-muted">
                  Enter the full path to any readable project folder.
                </p>
              </div>
            )}
            {!browsing && (
              <DialogFooter>
                <Button
                  onClick={() => validateAndProceed()}
                  disabled={!projectPath.trim() || isValidating}
                >
                  {isValidating ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      Validating...
                    </>
                  ) : (
                    "Continue"
                  )}
                </Button>
              </DialogFooter>
            )}
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <label htmlFor="name" className="text-sm font-medium text-t-secondary">
                  Project Name
                </label>
                <Input
                  id="name"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="My Project"
                  autoFocus
                />
              </div>
              {manifest && (
                <>
                  {beadsAvailable && (
                    <label className="flex items-center gap-2 text-sm text-t-secondary">
                      <Checkbox
                        checked={manifest.project.use_beads}
                        onCheckedChange={(checked) => setManifest({ ...manifest, project: { ...manifest.project, use_beads: checked === true } })}
                      />
                      Use task tracking for project work
                    </label>
                  )}
                  <div className="space-y-2">
                    <label htmlFor="manifest-storage" className="text-sm font-medium text-t-secondary">Store project settings</label>
                    <Select
                      value={storage}
                      onValueChange={(value) => setStorage(value as ManifestStorage)}
                    >
                      <SelectTrigger id="manifest-storage"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="personal">Only on this computer</SelectItem>
                        <SelectItem value="repository">In .atelier/project.toml</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {manifest.project.use_beads && (
                    <>
                      <div className="space-y-2">
                        <label htmlFor="issue-prefix" className="text-sm font-medium text-t-secondary">Issue ID prefix</label>
                        <Input id="issue-prefix" value={manifest.beads.issue_id_prefix} onChange={(event) => setManifest({ ...manifest, beads: { ...manifest.beads, issue_id_prefix: event.target.value } })} />
                      </div>
                      <div className="space-y-2">
                        <label htmlFor="completed-branch" className="text-sm font-medium text-t-secondary">Completed-work branch</label>
                        <Input id="completed-branch" list="project-branches" value={manifest.git.completed_work_branch} onChange={(event) => setManifest({ ...manifest, git: { ...manifest.git, completed_work_branch: event.target.value } })} />
                        <datalist id="project-branches">{branches.map((branch) => <option key={branch} value={branch} />)}</datalist>
                      </div>
                      <label className="flex items-center gap-2 text-sm text-t-secondary">
                        <Checkbox checked={manifest.git.agents_may_merge_completed_work} onCheckedChange={(checked) => setManifest({ ...manifest, git: { ...manifest.git, agents_may_merge_completed_work: checked === true } })} />
                        Allow agents to merge completed work
                      </label>
                    </>
                  )}
                  <Panel inset="sm" className="space-y-1 text-xs text-t-muted">
                    <p>{manifest.verification.commands.length} verification command(s) inferred</p>
                    <p>{manifest.beads.work_areas.length} work area(s) inferred</p>
                    <p>External review: {manifest.review.external_review.replace('_', ' ')}</p>
                  </Panel>
                </>
              )}
              <div className="space-y-2">
                <label className="text-sm font-medium text-t-secondary">Location</label>
                <Panel inset="sm" className="truncate text-sm text-t-tertiary">
                  {projectPath}
                </Panel>
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowNameInput(false)}
              >
                Back
              </Button>
              <Button type="submit" disabled={isSubmitting || !projectName.trim()}>
                {isSubmitting ? "Adding..." : "Add Project"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
