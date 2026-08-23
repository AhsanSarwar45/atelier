/**
 * The card's own side of the join: which chats touched this card.
 *
 * Read back from the board — `bd provenance log <bead>` — so a chat recorded
 * before this database existed still shows up (docs/agent-workbench.md §6.1).
 * Renders nothing at all when no chat has touched the card.
 */
'use client';

import { useEffect, useState } from 'react';

import { MessagesSquare } from 'lucide-react';

import { request } from '@/lib/api';
import type { LinkedChat } from '@/workbench/protocol';

interface CardChatsProps {
  beadId: string;
  projectId: string | null;
  /** The project folder, so the board is read where the card actually lives. */
  projectPath: string;
}

export function CardChats({ beadId, projectId, projectPath }: CardChatsProps) {
  const [chats, setChats] = useState<LinkedChat[]>([]);

  useEffect(() => {
    let live = true;
    const q = new URLSearchParams({ path: projectPath });
    request(`/api/workbench/links/bead/${encodeURIComponent(beadId)}?${q}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: LinkedChat[]) => {
        if (live) setChats(rows);
      })
      .catch(() => {
        // The workbench may simply not be running; the card is still usable.
      });
    return () => {
      live = false;
    };
  }, [beadId, projectPath]);

  if (!chats.length) return null;

  return (
    <div className="mt-6" data-testid="card-chats">
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-t-secondary">
        <MessagesSquare className="size-3.5" aria-hidden="true" />
        Chats ({chats.length})
      </h3>
      <div className="mb-3 h-px bg-b-default" />
      <div className="rounded-lg border border-b-default bg-surface-raised/50 p-3">
        <div className="space-y-1">
          {chats.map((c) => (
            <a
              key={c.sessionId}
              data-testid="card-chat-link"
              data-session-id={c.sessionId}
              href={`/project?id=${projectId ?? c.projectId ?? ''}&chat=${c.sessionId}&tab=chat`}
              className="block rounded px-2 py-1.5 text-sm transition hover:bg-accent"
            >
              <span className="text-foreground">{c.title ?? 'Untitled chat'}</span>
              <span className="ml-2 font-mono text-xs text-muted-foreground">
                {c.brand ?? 'chat'}
                {c.lastActiveAt ? ` · ${new Date(c.lastActiveAt).toLocaleString()}` : ''}
              </span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
