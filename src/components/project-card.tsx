"use client";

import { useState } from "react";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { AlertTriangle, Archive, ArchiveRestore, Code, FolderOpen, Settings } from "lucide-react";

import { StatusDonut } from "@/components/status-donut";
import { TagPicker } from "@/components/tag-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RoiuiCard } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/hooks/use-toast";
import * as api from "@/lib/api";
import type { Tag } from "@/lib/db";
import { projectTitle } from "@/lib/project-title";
import { deriveBeadPrefix } from "@/lib/utils";
import { NO_COUNTS, type BeadCounts } from "@/types";

/**
 * Returns the OS-appropriate file manager name
 */
function getFileManagerName(): string {
  if (typeof navigator === "undefined") return "File Manager";
  const platform = navigator.platform?.toLowerCase() ?? "";
  if (platform.startsWith("win")) return "Explorer";
  if (platform.startsWith("mac")) return "Finder";
  return "Files";
}

interface ProjectCardProps {
  id: string;
  name: string;
  path: string;
  localPath?: string;
  tags: Tag[];
  beadCounts?: BeadCounts;
  /**
   * True once `beadCounts` reflects either cached or freshly-fetched
   * data. When false, the card renders a dashed placeholder donut so
   * the user never sees misleading zeros on first paint.
   */
  countsLoaded?: boolean;
  dataSource?: string;
  beadError?: string;
  usesBeads?: boolean;
  archivedAt?: string;
  onTagsChange?: (tags: Tag[]) => void;
  onUpdated?: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
  onDelete?: () => void;
}

export function ProjectCard({
  id,
  name,
  path,
  localPath,
  tags,
  beadCounts = NO_COUNTS(),
  countsLoaded = true,
  dataSource,
  beadError,
  usesBeads = true,
  archivedAt,
  onTagsChange,
  onUnarchive,
}: ProjectCardProps) {
  const router = useRouter();
  const [isOpening, setIsOpening] = useState<string | null>(null);
  const { toast } = useToast();

  // For dolt projects, use localPath for filesystem operations; for regular projects use path
  const isDolt = path.startsWith("dolt://");
  const fsPath = isDolt ? localPath : path;

  const handleOpenExternal = async (target: 'vscode' | 'cursor' | 'finder', e: React.MouseEvent) => {
    e.stopPropagation();
    if (!fsPath) return;
    setIsOpening(target);

    try {
      await api.fs.openExternal(fsPath, target);
      toast({
        title: "Opening",
        description: target === 'finder'
          ? getFileManagerName()
          : target === 'vscode' ? 'VS Code' : 'Cursor',
      });
    } catch (err) {
      console.error("Error opening project:", err);
      toast({
        title: "Could not open project",
        description: err instanceof Error ? err.message : "Couldn’t open project. Check that the required app is installed.",
        variant: "destructive",
      });
    } finally {
      setIsOpening(null);
    }
  };

  const total = Object.values(beadCounts ?? {}).reduce<number>((n, c) => n + (typeof c === "number" ? c : 0), 0);
  const done = beadCounts?.closed ?? 0;

  return (
    <>
    {/* One link, stretched over the whole card, with the card's own buttons
        laid above it. The card used to be the link, and a link may not hold
        buttons: a screen reader heard the tag, settings and open buttons as
        part of a link's name, and a key pressed on them also opened the
        project (bw-lf8i.4). */}
    <RoiuiCard
      data-testid="project-card"
      className={`relative flex flex-col gap-3 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring${archivedAt ? ' opacity-50' : ''}`}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 text-xl font-medium text-balance font-project-name">
          <Link
            href={`/project?id=${id}`}
            // Navigation reuses the current document. Name it before the
            // project read begins, and retain the name for reloads in this tab.
            onClick={() => { document.title = projectTitle(id, name); }}
            className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
          >
            {name}
          </Link>
        </h3>
        <div className="relative flex flex-wrap items-center justify-end gap-1.5">
          {tags.map((tag) => (
            <Badge
              key={tag.id}
              size="sm"
              color={tag.color}
            >
              {tag.name}
            </Badge>
          ))}
          {onTagsChange && (
            <TagPicker
              projectId={id}
              projectTags={tags}
              onTagsChange={onTagsChange}
            />
          )}
        </div>
      </div>

      <p className="truncate text-sm text-t-muted" data-testid="project-path">
        {path}
      </p>

      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {usesBeads && (beadError ? (
            <Tooltip side="bottom" label={beadError}>
              <span className="relative flex items-center gap-1.5 text-sm text-warning">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                Board unreadable
              </span>
            </Tooltip>
          ) : (
            <span className="relative flex items-center gap-2 text-sm text-t-tertiary">
              <StatusDonut beadCounts={beadCounts} size={24} countsLoaded={countsLoaded} />
              {countsLoaded && (total === 0 ? "No tasks" : `${total} ${total === 1 ? "task" : "tasks"} · ${done} done`)}
            </span>
          ))}
          {archivedAt && (
            <Badge variant="secondary" appearance="light" size="sm" shape="circle" className="shrink-0 gap-1">
              <Archive className="h-3 w-3" aria-hidden="true" />
              Archived
            </Badge>
          )}
          {!archivedAt && dataSource === 'jsonl' && (
            <Tooltip
              label={
                <div className="space-y-1">
                  <p className="text-xs">
                    This project uses the old JSONL data format. Run this in the project directory to migrate to Dolt:
                  </p>
                  <Badge asChild variant="secondary" appearance="light" size="sm" className="w-full font-mono">
                    <code>bd init --prefix {deriveBeadPrefix(path, name)}</code>
                  </Badge>
                </div>
              }
            >
              <Badge
                variant="warning"
                appearance="outline"
                size="sm"
                shape="circle"
                className="relative shrink-0 gap-1"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                role="note"
                tabIndex={0}
                aria-label={`Old data format — migrate with bd init --prefix ${deriveBeadPrefix(path, name)}`}
              >
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                Old format — migrate
              </Badge>
            </Tooltip>
          )}
        </div>
        <div className="relative flex items-center gap-1 shrink-0">
          {archivedAt ? (
            <Tooltip label="Restore project">
              <Button
                variant="ghost"
                size="sm"
                mode="icon"
                className="shrink-0"
                onClick={(e) => { e.stopPropagation(); onUnarchive?.(); }}
                aria-label="Restore project"
              >
                <ArchiveRestore className="h-4 w-4" aria-hidden="true" />
              </Button>
            </Tooltip>
          ) : (
            <>
              <Tooltip label="Project settings">
                <Button
                  variant="ghost"
                  size="sm"
                  mode="icon"
                  className="shrink-0"
                  aria-label="Project settings"
                  onClick={(e) => {
                    e.stopPropagation();
                    router.push(`/project?id=${encodeURIComponent(id)}&settings=list`);
                  }}
                >
                  <Settings className="h-4 w-4" />
                </Button>
              </Tooltip>
              {fsPath && (
                  <DropdownMenu>
                    <Tooltip label="Open in editor or file manager">
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          mode="icon"
                          className="shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                          aria-label="Open in external application"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <FolderOpen className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                    </Tooltip>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={(e) => handleOpenExternal('vscode', e)}
                        disabled={isOpening !== null}
                      >
                        {isOpening === 'vscode' ? (
                          <Spinner />
                        ) : (
                          <Code className="h-4 w-4" aria-hidden="true" />
                        )}
                        VS Code
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={(e) => handleOpenExternal('cursor', e)}
                        disabled={isOpening !== null}
                      >
                        {isOpening === 'cursor' ? (
                          <Spinner />
                        ) : (
                          <Code className="h-4 w-4" aria-hidden="true" />
                        )}
                        Cursor
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={(e) => handleOpenExternal('finder', e)}
                        disabled={isOpening !== null}
                      >
                        {isOpening === 'finder' ? (
                          <Spinner />
                        ) : (
                          <FolderOpen className="h-4 w-4" aria-hidden="true" />
                        )}
                        {getFileManagerName()}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
            )}
            </>
          )}
        </div>
      </div>
    </RoiuiCard>
    </>
  );
}
