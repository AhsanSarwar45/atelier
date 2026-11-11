"use client";

import { useState } from "react";

import { Folder, FolderSearch } from "lucide-react";

import { FolderBrowser } from "@/components/folder-browser";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/hooks/use-toast";
import * as api from "@/lib/api";
import type { ManifestStorage, ProjectManifest } from "@/lib/api";
import { cn } from "@/lib/utils";


/**
 * What the server said about a refusal, without the wrapper's own prefix.
 *
 * A folder already on the home screen is answered deliberately — the server
 * names the project that already holds the path — and that sentence is the
 * whole of what a reader needs. `API error: 409` in front of it reads as a
 * fault in the app and buries the reason (bw-uk0k.2).
 */
function refusal(err: Error): string {
  return err.message.replace(/^API error: \d+ /, "").trim() || "Please try again.";
}

interface AddProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInitialized?: () => Promise<void> | void;
}

export function AddProjectDialog({
  open: isOpen,
  onOpenChange,
  onInitialized,
}: AddProjectDialogProps) {
  const [projectPath, setProjectPath] = useState<string>("");
  const [projectName, setProjectName] = useState<string>("");
  const [isValidating, setIsValidating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pathError, setPathError] = useState<string | null>(null);
  const [showNameInput, setShowNameInput] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [browserPath, setBrowserPath] = useState("");
  const [manifest, setManifest] = useState<ProjectManifest | null>(null);
  // The project's own instructions, carried from the probe so a folder that
  // already had them keeps them when it is added (bw-a9ln.4).
  const [instructions, setInstructions] = useState('');
  const [storage, setStorage] = useState<ManifestStorage>('personal');
  const { toast } = useToast();

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
      setPathError("Enter a project folder.");
      return;
    }

    setIsValidating(true);
    setPathError(null);

    try {
      const cleanPath = path.trim().replace(/[/\\]+$/, "");
      const probe = await api.projects.probe(cleanPath);

      setProjectPath(cleanPath);
      setProjectName(probe.manifest.project.display_name);
      setManifest(probe.manifest);
      setStorage(probe.storage ?? 'personal');
      setInstructions(probe.instructions || '');
      setShowNameInput(true);
      setBrowsing(false);
    } catch (err) {
      console.error("Error validating path:", err);
      const message = err instanceof Error ? err.message : String(err);
      setPathError(message.includes("API error")
        ? "Folder unavailable. Choose a local folder."
        : "Folder unavailable. Check the path.");
    } finally {
      setIsValidating(false);
    }
  };

  const handleBrowseSelect = (path: string) => {
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
      await api.projects.initialize(projectPath, storage, ready, instructions);
      await onInitialized?.();

      toast({
        title: "Project added",
        description: `Added ${projectName}.`,
      });

      resetState();
      onOpenChange(false);
    } catch (err) {
      console.error("Error adding project:", err);
      toast({
        title: "Couldn’t add project",
        description: err instanceof Error ? refusal(err) : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent shape="sheet" className={cn(browsing ? "sm:max-w-lg" : "sm:max-w-md")}>
        <DialogHeader>
          <DialogTitle>Add Project</DialogTitle>
          <DialogDescription>
            {showNameInput
              ? "Review the project details."
              : "Choose a project folder."}
          </DialogDescription>
        </DialogHeader>

        {!showNameInput ? (
          <div className="flex flex-col gap-4 py-4">
            {browsing ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-t-secondary">
                    Browse folders
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
                  Folder
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
                  <Tooltip label="Browse folders">
                    <Button
                      variant="outline"
                      size="md"
                      onClick={() => setBrowsing(true)}
                    >
                      <FolderSearch className="size-4" />
                      Browse
                    </Button>
                  </Tooltip>
                </div>
                {pathError && (
                  <p className="text-sm text-danger">{pathError}</p>
                )}
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
                      <Spinner />
                      Checking…
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
                <span className="text-sm font-medium text-t-secondary">Folder</span>
                <Panel inset="sm" className="truncate text-sm text-t-tertiary" title={projectPath}>
                  {projectPath}
                </Panel>
              </div>
              <div className="space-y-2">
                <label htmlFor="name" className="text-sm font-medium text-t-secondary">
                  Project name
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
                  <div className="space-y-2">
                    <label htmlFor="manifest-storage" className="text-sm font-medium text-t-secondary">Store project settings</label>
                    <Select
                      value={storage}
                      onValueChange={(value) => setStorage(value as ManifestStorage)}
                    >
                      <SelectTrigger id="manifest-storage"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="personal">Only on this computer</SelectItem>
                        <SelectItem value="repository">In the repository</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
              )}
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
                {isSubmitting ? "Adding…" : "Add Project"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
