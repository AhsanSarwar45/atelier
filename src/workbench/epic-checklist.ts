'use client';

import { useEffect, useMemo, useState } from 'react';

import { loadProjectBeads } from '@/lib/beads-parser';
import { standing, type Bead } from '@/types';
import { useHeardFromOutside } from '@/workbench/live';
import type { TodoItem } from '@/workbench/protocol';

/**
 * A provider asks for a checklist by naming exactly one epic. It does not own
 * the rows or their state: both come from the board (bw-j6vs.1).
 */
export function checklistForEpic(reference: TodoItem[], beads: Bead[]): TodoItem[] {
  if (reference.length !== 1) return [];
  const epicId = reference[0]?.text.trim();
  const epic = beads.find((bead) => bead.id === epicId && bead.issue_type === 'epic');
  if (!epic) return [];

  const byId = new Map(beads.map((bead) => [bead.id, bead]));
  const childIds = epic.children?.length
    ? epic.children
    : beads.filter((bead) => bead.parent_id === epic.id).map((bead) => bead.id);

  return childIds.flatMap((id) => {
    const child = byId.get(id);
    if (!child) return [];
    const status: TodoItem['status'] = !standing(child.status)
      ? 'completed'
      : child.status === 'in_progress'
        ? 'in_progress'
        : 'pending';
    return [{ id: child.id, text: child.title, status }];
  });
}

/** The board-backed checklist for this chat, refreshed by the project's wire. */
export function useEpicChecklist(reference: TodoItem[], projectPath: string | null): TodoItem[] {
  const changed = useHeardFromOutside(projectPath ?? '');
  const [beads, setBeads] = useState<Bead[]>([]);
  const epicId = reference.length === 1 ? reference[0]?.text.trim() : '';

  useEffect(() => {
    if (!projectPath || !epicId) {
      setBeads([]);
      return;
    }
    let alive = true;
    void loadProjectBeads(projectPath)
      .then((found) => { if (alive) setBeads(found); })
      .catch(() => { if (alive) setBeads([]); });
    return () => { alive = false; };
  }, [projectPath, epicId, changed]);

  return useMemo(() => checklistForEpic(reference, beads), [reference, beads]);
}
