"use client";

import { Badge } from "@/components/ui/badge";
import { beadTags, tagVariant } from "@/lib/bead-labels";
import { cn } from "@/lib/utils";
import type { Bead } from "@/types";

interface BeadTagsProps {
  bead: Pick<Bead, "labels">;
  className?: string;
}

/** The bead's system and kind chips; nothing at all when it carries neither. */
export function BeadTags({ bead, className }: BeadTagsProps) {
  const tags = beadTags(bead);
  if (tags.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {tags.map((tag) => (
        <Badge
          key={tag.raw}
          variant={tagVariant(tag)}
          appearance="outline"
          size="xs"
          className="theme-badge"
          title={tag.raw}
          data-bead-tag={tag.raw}
        >
          {tag.value}
        </Badge>
      ))}
    </div>
  );
}
