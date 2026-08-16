"use client";

import { Bug, Sparkles, Wrench, Tag as TagIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { beadTags, tagFor, tagHue } from "@/lib/bead-labels";
import { cn } from "@/lib/utils";
import type { Bead } from "@/types";

const KIND_ICONS: Record<string, typeof Bug> = {
  bug: Bug,
  feature: Sparkles,
  chore: Wrench,
};

/** The system this card belongs to; nothing when it names none. */
export function BeadSystemTag({ bead, className }: { bead: Pick<Bead, "labels">; className?: string }) {
  const tag = tagFor(bead, "area");
  if (!tag) return null;

  return (
    <Badge
      size="xs"
      appearance="light"
      hue={tagHue(tag)}
      className={cn("theme-badge font-semibold", className)}
      title={tag.raw}
      data-bead-tag={tag.raw}
    >
      {tag.value}
    </Badge>
  );
}

/** The kind of work this card is; nothing when it names none. */
export function BeadKindTag({ bead, className }: { bead: Pick<Bead, "labels">; className?: string }) {
  const tag = tagFor(bead, "kind");
  if (!tag) return null;
  const Icon = KIND_ICONS[tag.value] ?? TagIcon;

  return (
    // The kind of work reads first, so it carries the stronger fill.
    <Badge
      size="xs"
      hue={tagHue(tag)}
      className={cn("theme-badge gap-1 font-semibold", className)}
      title={tag.raw}
      data-bead-tag={tag.raw}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      {tag.value}
    </Badge>
  );
}

/** Both chips side by side, for rows that carry the card's facts together. */
export function BeadTags({ bead, className }: { bead: Pick<Bead, "labels">; className?: string }) {
  if (beadTags(bead).length === 0) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      <BeadSystemTag bead={bead} />
      <BeadKindTag bead={bead} />
    </div>
  );
}
