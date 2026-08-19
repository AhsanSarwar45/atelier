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

import { ExternalLink, FileText, MessagesSquare } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { apiUrl } from '@/lib/api-base';
import { cn } from '@/lib/utils';
import type { Bead } from '@/types';
import type { LinkedChat } from '@/workbench/protocol';

import type { ReportSpec } from '../types';

interface CardLink {
  id: string;
  title: string;
}

export function LinksRail({
  spec,
  projectId,
  projectPath,
  beadsById,
  onOpenCard,
  standaloneUrl,
  className,
}: {
  spec: ReportSpec;
  projectId: string | null;
  projectPath: string;
  beadsById: Map<string, Bead>;
  onOpenCard: (id: string) => void;
  /** The old self-contained page (`report-panel.tsx`'s `reportUrl()`), for the reader who wants it as it was. */
  standaloneUrl: string;
  className?: string;
}) {
  const primary: CardLink | null = useMemo(() => {
    const id = spec.status.card;
    if (!id) return null;
    return { id, title: beadsById.get(id)?.title ?? id };
  }, [spec.status.card, beadsById]);

  const questionCards: CardLink[] = useMemo(() => {
    const seen = new Set<string>();
    const out: CardLink[] = [];
    for (const q of spec.actions.questions) {
      if (!q.card || seen.has(q.card.id)) continue;
      seen.add(q.card.id);
      out.push({ id: q.card.id, title: q.card.title });
    }
    return out;
  }, [spec.actions.questions]);

  const statusItemCards: CardLink[] = useMemo(() => {
    const seen = new Set<string>(questionCards.map((c) => c.id));
    if (primary) seen.add(primary.id);
    const out: CardLink[] = [];
    for (const item of spec.status.items) {
      if (!item.card || seen.has(item.card)) continue;
      seen.add(item.card);
      const bead = beadsById.get(item.card);
      if (!bead) continue;
      out.push({ id: item.card, title: bead.title });
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
        fetch(apiUrl(`/api/workbench/links/bead/${encodeURIComponent(id)}?${q}`))
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
      className="w-full min-w-0 justify-start gap-2"
      onClick={() => onOpenCard(card.id)}
    >
      <FileText className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
      <span className="min-w-0 truncate">{card.title}</span>
      <Badge variant="secondary" appearance="outline" size="xs" shape="circle" className="ml-auto shrink-0 font-mono">
        {card.id}
      </Badge>
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

      <Button
        asChild
        type="button"
        variant="outline"
        size="sm"
        data-testid="report-link-standalone"
        className="w-full max-w-[18rem] shrink-0 justify-start gap-2 self-start"
      >
        <a href={standaloneUrl} target="_blank" rel="noreferrer">
          <ExternalLink className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
          Open on its own page
        </a>
      </Button>
    </aside>
  );
}
