/**
 * The report's own links rail: the card it is about, every card a question is
 * holding up, the other cards its checklist names, and the chats that have
 * touched any of them — so a report is not a dead end, and reading it puts
 * the board and the chats one click away (bw-7ks.21.4).
 *
 * The status card's own list only resolves a question's `card` server-side
 * (`types.ts`'s `ReportQuestion.card`); `status.card` and a checklist item's
 * `card` are bare ids. Rather than add a lookup the server doesn't already do,
 * their titles come from the project screen's own card list
 * (`app/project/board-cards.tsx`) — the same "one list, read once" the board
 * and the card panel already share. A card missing from that list is skipped
 * rather than shown as a bare id: nothing else in this report treats a board
 * the checklist can't reach specially either (`ReportSpec.board`, unused
 * anywhere in the app today), so a silent skip matches how the rest of the
 * report already behaves.
 *
 * The chats list reads the same join the card panel's own "Chats" section
 * does (`workbench/card-chats.tsx`) — `GET /api/workbench/links/bead/:id` —
 * run once per card this report touches and merged, since that route answers
 * for one card at a time and a report can be about several.
 */
'use client';

import { useEffect, useMemo, useState } from 'react';

import { FileText, MessagesSquare } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { request } from '@/lib/api';
import { cn } from '@/lib/utils';
import { STATE_BY_ID, type Bead, type BeadStatus } from '@/types';
import type { LinkedChat } from '@/workbench/protocol';

import type { ReportSpec } from '../types';

interface CardLink {
  id: string;
  title: string;
  /**
   * The board heading this card is filed under — "Todo", "In Progress", … —
   * or null while nothing here knows it yet. The board's list arrives a moment
   * after the report on a Dolt-backed project, and a column guessed in the
   * meantime is a wrong answer the reader cannot tell from a right one.
   */
  column: string | null;
}

/**
 * The column a card is drawn in, read the one way the board itself reads it
 * (`STATES` in `src/types/index.ts`). A status no state names falls to Todo,
 * which is the board's own fallback and the report builder's (`board.py`'s
 * `COLUMN`), so a card reads the same wherever it is shown.
 */
function columnOf(status: string | undefined): string {
  if (!status) return 'Todo';
  return STATE_BY_ID[status as BeadStatus]?.column ?? 'Todo';
}

export function LinksRail({
  spec,
  projectId,
  projectPath,
  beadsById,
  onOpenCard,
  className,
}: {
  spec: ReportSpec;
  projectId: string | null;
  projectPath: string;
  beadsById: Map<string, Bead>;
  onOpenCard: (id: string) => void;
  className?: string;
}) {
  const primary: CardLink | null = useMemo(() => {
    const id = spec.status.card;
    if (!id) return null;
    const bead = beadsById.get(id);
    return { id, title: bead?.title ?? id, column: bead ? columnOf(bead.status) : null };
  }, [spec.status.card, beadsById]);

  const questionCards: CardLink[] = useMemo(() => {
    const seen = new Set<string>();
    const out: CardLink[] = [];
    for (const q of spec.actions.questions) {
      if (!q.card || seen.has(q.card.id)) continue;
      seen.add(q.card.id);
      const bead = beadsById.get(q.card.id);
      out.push({
        id: q.card.id,
        title: bead?.title ?? q.card.title,
        column: bead ? columnOf(bead.status) : q.card.column,
      });
    }
    return out;
  }, [spec.actions.questions, beadsById]);

  const statusItemCards: CardLink[] = useMemo(() => {
    const seen = new Set<string>(questionCards.map((c) => c.id));
    if (primary) seen.add(primary.id);
    const out: CardLink[] = [];
    for (const item of spec.status.items) {
      if (!item.card || seen.has(item.card)) continue;
      seen.add(item.card);
      const bead = beadsById.get(item.card);
      if (!bead) continue;
      out.push({ id: item.card, title: bead.title, column: columnOf(bead.status) });
    }
    return out;
  }, [spec.status.items, primary, questionCards, beadsById]);

  const relatedKey = useMemo(() => {
    const ids = new Set<string>();
    if (primary) ids.add(primary.id);
    questionCards.forEach((c) => ids.add(c.id));
    statusItemCards.forEach((c) => ids.add(c.id));
    return Array.from(ids).sort().join(',');
  }, [primary, questionCards, statusItemCards]);

  const [chats, setChats] = useState<LinkedChat[]>([]);
  useEffect(() => {
    const ids = relatedKey ? relatedKey.split(',') : [];
    if (ids.length === 0) {
      setChats([]);
      return undefined;
    }
    let live = true;
    const q = new URLSearchParams({ path: projectPath });
    Promise.all(
      ids.map((id) =>
        request(`/api/workbench/links/bead/${encodeURIComponent(id)}?${q}`)
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => [] as LinkedChat[]),
      ),
    ).then((lists: LinkedChat[][]) => {
      if (!live) return;
      const bySession = new Map<string, LinkedChat>();
      for (const list of lists) for (const c of list) bySession.set(c.sessionId, c);
      setChats(Array.from(bySession.values()));
    });
    return () => {
      live = false;
    };
  }, [relatedKey, projectPath]);

  const cardRow = (card: CardLink, testid: string) => (
    <Button
      key={card.id}
      type="button"
      variant="ghost"
      size="sm"
      data-testid={testid}
      data-card-id={card.id}
      data-card-column={card.column ?? undefined}
      className="h-auto w-full min-w-0 justify-start gap-2 py-1.5"
      onClick={() => onOpenCard(card.id)}
    >
      <FileText className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
      <span className="flex min-w-0 flex-col items-start gap-0.5">
        <span className="min-w-0 max-w-full truncate">{card.title}</span>
        <span className="flex items-center gap-1.5 text-xs font-normal text-t-muted">
          {card.column && <span data-testid="report-link-column">{card.column}</span>}
          <Badge variant="secondary" appearance="outline" size="xs" shape="circle" className="font-mono">
            {card.id}
          </Badge>
        </span>
      </span>
    </Button>
  );

  return (
    <aside aria-label="Report links" data-testid="report-links" className={cn('flex flex-col gap-4', className)}>
      {primary && (
        <Panel inset="sm" className="flex w-full max-w-[18rem] shrink-0 flex-col gap-1 self-start" data-testid="report-links-about">
          <p className="px-1 text-xs font-bold uppercase tracking-wide text-t-muted">This report is about</p>
          {cardRow(primary, 'report-link-primary-card')}
        </Panel>
      )}

      {questionCards.length > 0 && (
        <Panel inset="sm" className="flex w-full max-w-[18rem] shrink-0 flex-col gap-1 self-start" data-testid="report-links-questions">
          <p className="px-1 text-xs font-bold uppercase tracking-wide text-t-muted">Waiting on</p>
          {questionCards.map((c) => cardRow(c, 'report-link-question-card'))}
        </Panel>
      )}

      {statusItemCards.length > 0 && (
        <Panel inset="sm" className="flex w-full max-w-[18rem] shrink-0 flex-col gap-1 self-start" data-testid="report-links-status-items">
          <p className="px-1 text-xs font-bold uppercase tracking-wide text-t-muted">Also on the board</p>
          {statusItemCards.map((c) => cardRow(c, 'report-link-status-card'))}
        </Panel>
      )}

      {chats.length > 0 && (
        <Panel inset="sm" className="flex w-full max-w-[18rem] shrink-0 flex-col gap-1 self-start" data-testid="report-links-chats">
          <p className="px-1 text-xs font-bold uppercase tracking-wide text-t-muted">Chats about it</p>
          {chats.map((c) => (
            <a
              key={c.sessionId}
              data-testid="report-link-chat"
              data-session-id={c.sessionId}
              href={`/project?id=${projectId ?? c.projectId ?? ''}&chat=${c.sessionId}&tab=chat`}
              className="flex min-w-0 items-center gap-2 rounded px-2 py-1.5 text-sm transition hover:bg-surface-overlay"
            >
              <MessagesSquare className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
              <span className="min-w-0 truncate">{c.title ?? 'Untitled chat'}</span>
            </a>
          ))}
        </Panel>
      )}

    </aside>
  );
}
