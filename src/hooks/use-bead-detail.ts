"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";

import { PANEL_SLIDE_MS } from "@/components/bead-detail";
import type { Bead } from "@/types";

export interface UseBeadDetailResult {
  /** The currently selected bead (resolved from allBeads) */
  detailBead: Bead | null;
  /** Whether the detail panel is open */
  isDetailOpen: boolean;
  /** Open detail for a bead */
  openBead: (bead: Bead) => void;
  /** Handle detail panel open/close */
  handleDetailOpenChange: (open: boolean) => void;
  /** Navigate to a bead by ID (for dependencies, memory panel, etc.) */
  navigateToBead: (beadId: string) => void;
}

/**
 * Manages bead detail panel state: which bead is selected, open/close logic.
 *
 * @param allBeads - All beads array (used to resolve bead by ID)
 */
export function useBeadDetail(allBeads: Bead[]): UseBeadDetailResult {
  const [detailBeadId, setDetailBeadId] = useState<string | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);

  const detailBead = useMemo(() => {
    if (!detailBeadId) return null;
    return allBeads.find((b) => b.id === detailBeadId) || null;
  }, [detailBeadId, allBeads]);

  // The panel only exists while a bead is selected, so the selection has to
  // outlive the close by the length of the slide out or it is cut off.
  const clearing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdOpen = useCallback((id: string) => {
    if (clearing.current) clearTimeout(clearing.current);
    setDetailBeadId(id);
    setIsDetailOpen(true);
  }, []);
  useEffect(() => () => { if (clearing.current) clearTimeout(clearing.current); }, []);

  const openBead = useCallback((bead: Bead) => holdOpen(bead.id), [holdOpen]);

  const handleDetailOpenChange = useCallback((open: boolean) => {
    setIsDetailOpen(open);
    if (!open) {
      clearing.current = setTimeout(() => setDetailBeadId(null), PANEL_SLIDE_MS);
    }
  }, []);

  const navigateToBead = useCallback((beadId: string) => {
    const found = allBeads.find((b) => b.id === beadId);
    if (found) holdOpen(found.id);
  }, [allBeads, holdOpen]);

  return {
    detailBead,
    isDetailOpen,
    openBead,
    handleDetailOpenChange,
    navigateToBead,
  };
}
