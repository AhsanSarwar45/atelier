/**
 * The one card panel, mounted by the project screen and driven by the address.
 *
 * A card opens where the reader already is: a chip on a chat's line, a chip on a
 * chat's row and a card on the board all put `card=<id>` in the address, and this
 * slides the same panel over whichever tab is showing
 * (docs/designs/app-shell.md §1.8).
 *
 * It reads the project screen's own card list (src/app/project/board-cards.tsx),
 * so an edit made here moves the card on the board behind it at once, and the
 * list is fetched once however many parts are reading it.
 *
 * That list is read brief: no notes, design, close reason or comments
 * (bw-fbzd.7). The panel draws the list's copy at once and fetches the whole
 * card beside it, again whenever the list's copy of it changes.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { useBoardCards } from '@/app/project/board-cards';
import * as api from '@/lib/api';
import { ActivityTimeline } from '@/components/activity-timeline';
import { BeadDetail, PANEL_SLIDE_MS } from '@/components/bead-detail';
import { CommentList } from '@/components/comment-list';
import { ErrorBoundary } from '@/components/error-boundary';
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
  const { beads, refresh } = useBoardCards();
  const listed = beads.find((b) => b.id === cardId) ?? null;

  // The whole card, once fetched; `bead: null` means the fetch failed and the
  // list's copy is all there is.
  const [whole, setWhole] = useState<{ id: string; bead: Bead | null } | null>(null);
  const asked = useRef(0);
  const fetchWhole = useCallback(() => {
    const ask = ++asked.current;
    api.beads
      .card(projectPath, cardId)
      .then(({ bead: found }) => { if (ask === asked.current) setWhole({ id: cardId, bead: found }); })
      .catch(() => { if (ask === asked.current) setWhole({ id: cardId, bead: null }); });
  }, [projectPath, cardId]);
  const listedStamp = listed ? `${listed.updated_at}|${listed.comment_count ?? ''}` : null;
  useEffect(() => {
    if (listedStamp !== null) fetchWhole();
  }, [fetchWhole, listedStamp]);
  const commentAdded = useCallback(() => {
    fetchWhole();
    return refresh();
  }, [fetchWhole, refresh]);

  const detail = whole?.id === cardId ? whole : null;
  // The list's copy is newer for everything it carries; only the long text
  // comes from the whole card.
  const bead: Bead | null = listed && detail?.bead
    ? {
        ...listed,
        design: detail.bead.design ?? undefined,
        notes: detail.bead.notes ?? undefined,
        close_reason: detail.bead.close_reason ?? undefined,
        comments: detail.bead.comments ?? [],
      }
    : listed;

  // A Dolt-only board has no directory, so there is no worktree to read.
  const isDoltOnly = isDoltProject(projectPath) && !projectLocalPath;
  const fsPath = projectDir({ path: projectPath, localPath: projectLocalPath });
  const { statuses } = useWorktreeStatuses(isDoltOnly ? '' : fsPath, bead ? [bead.id] : []);

  // The panel is unmounted by whoever owns the address, so the slide out has to
  // be waited for here or it is cut off (PANEL_SLIDE_MS is the panel's own).
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
        worktreeStatus={isDoltOnly ? undefined : statuses[bead.id]}
        open={open}
        onOpenChange={change}
        projectPath={projectPath}
        allBeads={beads}
        onChildClick={(child: Bead) => onOpenCard(child.id)}
        onUpdate={refresh}
      >
        {/* A brief copy's empty comments would read "No comments yet". */}
        {(detail || !bead.comment_count) && (
          <CommentList
            comments={bead.comments}
            beadId={bead.id}
            projectPath={projectPath}
            onCommentAdded={commentAdded}
          />
        )}
        <ActivityTimeline
          bead={bead}
          comments={bead.comments}
          childBeads={(bead.children || [])
            .map((id) => beads.find((b) => b.id === id))
            .filter((b): b is Bead => !!b)}
        />
        <CardChats beadId={bead.id} projectId={projectId} projectPath={projectPath} />
        <StartFromCard bead={bead} projectId={projectId} projectPath={projectPath} waiting={!detail} />
      </BeadDetail>
    </ErrorBoundary>
  );
}
