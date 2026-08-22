"use client";

import { useState, useEffect, useCallback, useRef, useId } from "react";

import { Folder, FolderOpen, ChevronRight, Home } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import * as api from "@/lib/api";
import type { FsEntry } from "@/lib/api";
import { cn } from "@/lib/utils";


interface FolderBrowserProps {
  currentPath: string;
  onPathChange: (path: string) => void;
  onSelectPath: (path: string, hasBeads: boolean) => void;
  className?: string;
}

interface DirectoryEntry extends FsEntry {
  hasBeads: boolean;
}

/** Check if a path looks like a Windows drive root (e.g. "C:\") */
function isDriveRoot(p: string): boolean {
  return /^[A-Za-z]:[/\\]?$/.test(p);
}

/** Get the parent of a path, handling both Unix and Windows styles */
function getParentPath(p: string): string | null {
  // Unix root
  if (p === "/") return null;
  // Windows drive root  e.g. "C:\"
  if (isDriveRoot(p)) return null;
  // Strip trailing separator
  const trimmed = p.replace(/[/\\]+$/, "");
  const lastSep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (lastSep <= 0 && trimmed.startsWith("/")) return "/";
  if (lastSep < 0) return null;
  const parent = trimmed.substring(0, lastSep);
  // If parent is like "C:", return "C:\"
  if (/^[A-Za-z]:$/.test(parent)) return parent + "\\";
  return parent || "/";
}

/** Split a path into breadcrumb segments */
function pathToSegments(p: string): { label: string; path: string }[] {
  const segments: { label: string; path: string }[] = [];
  // Handle Windows drive letter
  const driveMatch = p.match(/^([A-Za-z]):[/\\]/);
  if (driveMatch) {
    const driveRoot = driveMatch[1].toUpperCase() + ":\\";
    segments.push({ label: driveRoot, path: driveRoot });
    const rest = p.substring(driveRoot.length);
    const parts = rest.split(/[/\\]/).filter(Boolean);
    let current = driveRoot;
    for (const part of parts) {
      current = current.replace(/[/\\]$/, "") + "\\" + part;
      segments.push({ label: part, path: current });
    }
  } else {
    // Unix-style
    const parts = p.split("/").filter(Boolean);
    segments.push({ label: "/", path: "/" });
    let current = "";
    for (const part of parts) {
      current += "/" + part;
      segments.push({ label: part, path: current });
    }
  }
  return segments;
}

export function FolderBrowser({
  currentPath,
  onPathChange,
  onSelectPath,
  className,
}: FolderBrowserProps) {
  const [directories, setDirectories] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const [currentPathHasBeads, setCurrentPathHasBeads] = useState(false);
  const [homeDir, setHomeDir] = useState<string>("");
  const [driveRoots, setDriveRoots] = useState<string[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  // Panel isn't a forwardRef component, so the breadcrumb strip is found by
  // id rather than a ref (bw-81wt.2).
  const breadcrumbId = useId();

  // A path can't fit an arbitrarily deep breadcrumb trail on a phone screen,
  // so the strip scrolls horizontally (Panel's own overflow-x-auto) — but
  // left un-scrolled, the CURRENT folder (the last, most relevant segment)
  // was the one cut off the right edge. Snap to the end on every navigation
  // so the folder you're actually in is always the visible one (bw-81wt.2).
  useEffect(() => {
    const el = document.getElementById(breadcrumbId);
    if (el) el.scrollLeft = el.scrollWidth;
  }, [currentPath, breadcrumbId]);

  // Load home dir and roots on mount
  useEffect(() => {
    api.fs.roots().then(({ home, roots }) => {
      setHomeDir(home);
      setDriveRoots(roots);
      // If no currentPath yet, start at home
      if (!currentPath) {
        onPathChange(home);
      }
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load directories when path changes
  useEffect(() => {
    const loadDirectories = async () => {
      if (!currentPath) return;

      setLoading(true);
      setError(null);
      setSelectedIndex(-1);

      try {
        const cleanPath = currentPath.replace(/[/\\]+$/, "") || currentPath;
        // Fetch directory contents and check if current path has beads in parallel
        const [listResult, currentBeadsResult] = await Promise.all([
          api.fs.list(currentPath),
          api.fs.exists(`${cleanPath}/.beads`),
        ]);

        // Filter to only directories
        const dirs = listResult.entries.filter((entry) => entry.isDirectory);

        // Check which directories have .beads folders in parallel
        // Some system dirs (e.g. "System Volume Information") may return 403 — ignore those
        const dirsWithBeadsStatus = await Promise.all(
          dirs.map(async (dir) => {
            try {
              const beadsPath = `${dir.path}/.beads`;
              const result = await api.fs.exists(beadsPath);
              return { ...dir, hasBeads: result.exists };
            } catch {
              return { ...dir, hasBeads: false };
            }
          })
        );

        // Sort: directories with .beads first, then alphabetically
        dirsWithBeadsStatus.sort((a, b) => {
          if (a.hasBeads && !b.hasBeads) return -1;
          if (!a.hasBeads && b.hasBeads) return 1;
          return a.name.localeCompare(b.name);
        });

        setDirectories(dirsWithBeadsStatus);
        setCurrentPathHasBeads(currentBeadsResult.exists);
      } catch (err) {
        console.error("Error loading directories:", err);
        setError(err instanceof Error ? err.message : "Failed to load directories");
        setDirectories([]);
      } finally {
        setLoading(false);
      }
    };

    loadDirectories();
  }, [currentPath]);

  const navigateToDirectory = useCallback(
    (path: string) => {
      onPathChange(path);
    },
    [onPathChange]
  );

  const navigateUp = useCallback(() => {
    const parent = getParentPath(currentPath);
    if (parent) onPathChange(parent);
  }, [currentPath, onPathChange]);

  const navigateToHome = useCallback(() => {
    if (homeDir) onPathChange(homeDir);
  }, [homeDir, onPathChange]);

  const breadcrumbs = currentPath ? pathToSegments(currentPath) : [];

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (directories.length === 0) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev < directories.length - 1 ? prev + 1 : prev
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
          break;
        case "Enter":
          e.preventDefault();
          if (selectedIndex >= 0 && selectedIndex < directories.length) {
            navigateToDirectory(directories[selectedIndex].path);
          }
          break;
        case "Backspace":
          if (getParentPath(currentPath)) {
            e.preventDefault();
            navigateUp();
          }
          break;
      }
    },
    [directories, selectedIndex, navigateToDirectory, navigateUp, currentPath]
  );

  const handleSelect = useCallback(() => {
    onSelectPath(currentPath, currentPathHasBeads);
  }, [currentPath, currentPathHasBeads, onSelectPath]);

  return (
    <div
      className={cn("flex flex-col gap-3", className)}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="application"
      aria-label="Folder browser"
    >
      {/* Breadcrumb navigation */}
      <Panel id={breadcrumbId} inset="none" className="flex items-center gap-1 overflow-x-auto px-2 py-1.5 text-sm">
        <Button
          variant="ghost"
          size="xs"
          mode="icon"
          onClick={navigateToHome}
          aria-label="Go to home directory"
          // 28px (size="xs" mode="icon") is fine for a mouse; a finger
          // needs the full 40 (bw-81wt.2).
          className="shrink-0 [@media(pointer:coarse)]:size-10"
        >
          <Home />
        </Button>
        {/* Drive selector on Windows */}
        {driveRoots.length > 1 && (
          <>
            <ChevronRight className="size-3 shrink-0 text-t-muted" />
            <div className="flex items-center gap-0.5 shrink-0">
              {driveRoots.map((root) => (
                <Badge
                  key={root}
                  asChild
                  size="sm"
                  variant={
                    currentPath.toUpperCase().startsWith(root.charAt(0).toUpperCase()) ? 'secondary' : 'outline'
                  }
                  appearance="light"
                  className="font-mono"
                >
                  <button
                    type="button"
                    onClick={() => navigateToDirectory(root)}
                    title={root}
                    className="[@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:px-2"
                  >
                    {root.charAt(0)}:
                  </button>
                </Badge>
              ))}
            </div>
          </>
        )}
        <ChevronRight className="size-3 shrink-0 text-t-muted" />
        {breadcrumbs.map((seg, index) => {
          const isLast = index === breadcrumbs.length - 1;
          // Skip drive root in breadcrumbs if drives are shown above
          if (index === 0 && driveRoots.length > 1 && isDriveRoot(seg.path)) return null;

          return (
            <div key={seg.path} className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => navigateToDirectory(seg.path)}
                className={cn(
                  "rounded px-1 py-0.5 text-sm transition-colors hover:bg-surface-raised",
                  // Breadcrumb segments are plain inline buttons; on touch
                  // they need real height and vertical centering, not just
                  // a taller box (bw-81wt.2).
                  "[@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:items-center",
                  isLast ? "text-t-primary" : "text-t-tertiary"
                )}
              >
                {seg.label}
              </button>
              {!isLast && (
                <ChevronRight className="size-3 shrink-0 text-t-muted" />
              )}
            </div>
          );
        })}
      </Panel>

      {/* Current path beads indicator */}
      {currentPathHasBeads && (
        <Panel tone="info" className="flex items-center gap-2">
          <Badge variant="info" size="sm">
            .beads found
          </Badge>
          <span className="text-xs text-t-tertiary">
            This folder holds a tracked project
          </span>
        </Panel>
      )}

      {/* Directory list */}
      <ScrollArea className="h-[300px] rounded-md border border-b-strong bg-surface-overlay/50">
        <div ref={listRef} className="p-2" role="listbox" aria-label="Directories">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-t-muted">
              <div className="size-4 animate-spin rounded-full border-2 border-b-strong border-t-transparent" />
              <span className="ml-2 text-sm">Loading...</span>
            </div>
          ) : error ? (
            <div className="py-8 text-center text-sm text-danger">{error}</div>
          ) : directories.length === 0 ? (
            <div className="py-8 text-center text-sm text-t-muted">
              No subdirectories found
            </div>
          ) : (
            directories.map((dir, index) => (
              <button
                key={dir.path}
                type="button"
                role="option"
                aria-selected={selectedIndex === index}
                onClick={() => setSelectedIndex(index)}
                onDoubleClick={() => navigateToDirectory(dir.path)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                  // Rows are ~32px tall by padding alone; bump to a real
                  // 40px tap target on touch (bw-81wt.2).
                  "[@media(pointer:coarse)]:min-h-10",
                  selectedIndex === index
                    ? "bg-surface-raised text-t-primary"
                    : "text-t-secondary hover:bg-surface-raised/50",
                  dir.hasBeads && "border-l-2 border-info"
                )}
              >
                {selectedIndex === index ? (
                  <FolderOpen className="size-4 shrink-0 text-t-tertiary" />
                ) : (
                  <Folder
                    className={cn(
                      "size-4 shrink-0",
                      dir.hasBeads ? "text-info" : "text-t-tertiary"
                    )}
                  />
                )}
                <span className="truncate">{dir.name}</span>
                {dir.hasBeads && (
                  <Badge variant="info" size="xs" className="ml-auto shrink-0">
                    .beads
                  </Badge>
                )}
              </button>
            ))
          )}
        </div>
      </ScrollArea>

      {/* Keyboard hints */}
      <div className="text-xs text-t-muted">
        Double-click or press Enter to open. Backspace to go up.
      </div>

      {/* Select button */}
      <Button
        onClick={handleSelect}
        disabled={!currentPath || loading}
        // 36px (default md size) is under the 40px touch minimum
        // (bw-81wt.2); untouched on mouse.
        className="w-full [@media(pointer:coarse)]:h-10"
      >
        Select This Folder
      </Button>
    </div>
  );
}
