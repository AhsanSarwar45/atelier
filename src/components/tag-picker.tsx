"use client";

import * as React from "react";

import { Plus, Check, X } from "lucide-react";

import { ColorPicker } from "@/components/color-picker";
import { Badge, BadgeDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Row } from "@/components/ui/row";
import { Separator } from "@/components/ui/separator";
import type { Tag } from "@/lib/db";
import {
  getTags,
  createTag,
  addTagToProject,
  removeTagFromProject,
} from "@/lib/db";
import { cn } from "@/lib/utils";

interface TagPickerProps {
  projectId: string;
  projectTags: Tag[];
  onTagsChange: (tags: Tag[]) => void;
  className?: string;
}

export function TagPicker({
  projectId,
  projectTags,
  onTagsChange,
  className,
}: TagPickerProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [allTags, setAllTags] = React.useState<Tag[]>([]);
  const [isCreating, setIsCreating] = React.useState(false);
  const [newTagName, setNewTagName] = React.useState("");
  const [newTagColor, setNewTagColor] = React.useState("#3b82f6");
  const [isLoading, setIsLoading] = React.useState(false);

  // Load all tags when popover opens
  React.useEffect(() => {
    if (isOpen) {
      loadTags();
    }
  }, [isOpen]);

  const loadTags = async () => {
    try {
      const tags = await getTags();
      setAllTags(tags);
    } catch (error) {
      console.error("Failed to load tags:", error);
    }
  };

  const isTagSelected = (tagId: string) => {
    return projectTags.some((t) => t.id === tagId);
  };

  const handleToggleTag = async (tag: Tag) => {
    setIsLoading(true);
    try {
      if (isTagSelected(tag.id)) {
        await removeTagFromProject(projectId, tag.id);
        onTagsChange(projectTags.filter((t) => t.id !== tag.id));
      } else {
        await addTagToProject(projectId, tag.id);
        onTagsChange([...projectTags, tag]);
      }
    } catch (error) {
      console.error("Failed to toggle tag:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateTag = async () => {
    if (!newTagName.trim()) return;

    setIsLoading(true);
    try {
      const newTag = await createTag({
        name: newTagName.trim(),
        color: newTagColor,
      });
      setAllTags([...allTags, newTag]);
      // Auto-add to project
      await addTagToProject(projectId, newTag.id);
      onTagsChange([...projectTags, newTag]);
      // Reset form
      setNewTagName("");
      setNewTagColor("#3b82f6");
      setIsCreating(false);
    } catch (error) {
      console.error("Failed to create tag:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancelCreate = () => {
    setNewTagName("");
    setNewTagColor("#3b82f6");
    setIsCreating(false);
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Add tag"
          className={cn(
            "h-6 gap-1 rounded-full px-2 text-xs text-t-tertiary",
            "hover:bg-surface-overlay",
            className
          )}
          onClick={(e) => {
            // Only stop propagation to prevent Link navigation
            // Do NOT call e.preventDefault() - let Radix handle the click
            e.stopPropagation();
          }}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Tag
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-64 p-2"
        align="start"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="space-y-2">
          {/* Existing tags list */}
          {allTags.length > 0 && (
            <div className="space-y-1">
              {allTags.map((tag) => (
                <Row
                  key={tag.id}
                  gap="md"
                  inset="sm"
                  radius="md"
                  className="text-sm"
                  onClick={() => handleToggleTag(tag)}
                  disabled={isLoading}
                  aria-pressed={isTagSelected(tag.id)}
                >
                  <BadgeDot size="md" solid color={tag.color} />
                  <span className="flex-1 truncate">{tag.name}</span>
                  {isTagSelected(tag.id) && (
                    <Check className="h-4 w-4 text-success shrink-0" aria-hidden="true" />
                  )}
                </Row>
              ))}
            </div>
          )}

          {/* Divider */}
          {allTags.length > 0 && <Separator />}

          {/* Create new tag section */}
          {isCreating ? (
            <div className="space-y-2 p-1">
              <div className="flex items-center gap-2">
                <ColorPicker
                  value={newTagColor}
                  onChange={setNewTagColor}
                />
                <Input
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  placeholder="Tag name"
                  aria-label="Tag name"
                  className="h-8 text-sm"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleCreateTag();
                    } else if (e.key === "Escape") {
                      handleCancelCreate();
                    }
                  }}
                />
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  className="h-7 flex-1"
                  onClick={handleCreateTag}
                  disabled={!newTagName.trim() || isLoading}
                >
                  Create
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  onClick={handleCancelCreate}
                  aria-label="Cancel"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </div>
          ) : (
            <Row
              gap="md"
              inset="sm"
              radius="md"
              className="text-sm text-t-tertiary"
              onClick={() => setIsCreating(true)}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              <span>Create new tag</span>
            </Row>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface TagBadgeListProps {
  tags: Tag[];
  className?: string;
}

export function TagBadgeList({ tags, className }: TagBadgeListProps) {
  if (tags.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {tags.map((tag) => (
        <Badge
          key={tag.id}
          variant="secondary"
          className="text-xs"
          style={{
            backgroundColor: `${tag.color}20`,
            color: tag.color,
            borderColor: tag.color,
          }}
        >
          {tag.name}
        </Badge>
      ))}
    </div>
  );
}
