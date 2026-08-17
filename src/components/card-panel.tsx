/**
 * The one card panel, mounted by the project screen and driven by the address.
 *
 * A card opens where the reader already is: a chip on a chat's line, a chip on a
 * chat's row and a card on the board all put `card=<id>` in the address, and this
 * slides the same panel over whichever tab is showing
 * (docs/designs/app-shell.md §1.8).
 *
 * It reads the card list itself and is mounted only while a card is open, so the
 * chat tab pays nothing for it when no card is open.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { ActivityTimeline } from '@/components/activity-timeline';
import { BeadDetail, PANEL_SLIDE_MS } from '@/components/bead-detail';
import { CommentList } from '@/components/comment-list';
import { ErrorBoundary } from '@/components/error-boundary';
import { useBeads } from '@/hooks/use-beads';
import { useWorktreeStatuses } from '@/hooks/use-worktree-statuses';
import { isDoltProject, projectDir } from '@/lib/utils';
import type { Bead } from '@/types';
import { CardChats } from '@/workbench/card-chats';
import { StartFromCard } from '@/workbench/start-from-card';

export function CardPanel({
  cardId,
  projectId,
  projectPath,
  projectLocalPath,
  onClose,
  onOpenCard,
}: {
  cardId: string;
  projectId: string | null;
  projectPath: string;
  projectLocalPath?: string | null;
  /** Called once the panel has finished sliding out. */
  onClose: () => void;
  /** A card named inside this one — a child, or something it depends on. */
  onOpenCard: (id: string) => void;
}) {
  const { beads, ticketNumbers, refresh } = useBeads(projectPath);
  const bead = beads.find((b) => b.id === cardId) ?? null;

  // A Dolt-only board has no directory, so there is no worktree to read.
  const isDoltOnly = isDoltProject(projectPath) && !projectLocalPath;
  const fsPath = projectDir({ path: projectPath, localPath: projectLocalPath });
  const { statuses } = useWorktreeStatuses(isDoltOnly ? '' : fsPath, bead ? [bead.id] : []);

  // The panel is unmounted by whoever owns the address, so the slide out has to
  // be waited for here or it is cut off — the same rule use-bead-detail follows.
  const [open, setOpen] = useState(true);
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (leaving.current) clearTimeout(leaving.current); }, []);
  // A new card in the address is a new card in the panel, without a slide.
  useEffect(() => setOpen(true), [cardId]);

  const change = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) leaving.current = setTimeout(onClose, PANEL_SLIDE_MS);
    },
    [onClose],
  );

  // Nothing to draw until the list has arrived; a card that is not on this board
  // simply closes rather than leaving an empty panel behind.
  if (!bead) return null;

  return (
    <ErrorBoundary label="Card panel">
      <BeadDetail
        bead={bead}
        ticketNumber={ticketNumbers.get(bead.id)}
        worktreeStatus={isDoltOnly ? undefined : statuses[bead.id]}
        open={open}
        onOpenChange={change}
        projectPath={projectPath}
        allBeads={beads}
        onChildClick={(child: Bead) => onOpenCard(child.id)}
        onUpdate={refresh}
      >
        <CommentList
          comments={bead.comments}
          beadId={bead.id}
          projectPath={projectPath}
          onCommentAdded={refresh}
        />
        <ActivityTimeline
          bead={bead}
          comments={bead.comments}
          childBeads={(bead.children || [])
            .map((id) => beads.find((b) => b.id === id))
            .filter((b): b is Bead => !!b)}
        />
        <CardChats beadId={bead.id} projectId={projectId} projectPath={projectPath} />
        <StartFromCard bead={bead} projectId={projectId} projectPath={projectPath} />
      </BeadDetail>
    </ErrorBoundary>
  );
}
