/**
 * One search across every conversation, in every project.
 *
 * Matches are shown as the sentence they fell in, with the words themselves
 * marked, so the owner can tell which of five chats is the one he means before
 * opening any of them (docs/agent-workbench.md §8.4e).
 */
'use client';

import { useEffect, useState } from 'react';

import { useRouter } from 'next/navigation';

import { X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import * as api from '@/lib/api';
import { request } from '@/lib/api';

export interface Match {
  sessionId: string;
  messageId: string;
  role: string;
  sentence: string;
  match: string;
  at: string;
  title: string | null;
  projectId: string;
}

/** The sentence in three pieces, so the words that matched can be marked. */
export function split(sentence: string, match: string): [string, string, string] {
  const at = match ? sentence.toLowerCase().indexOf(match.toLowerCase()) : -1;
  if (at < 0) return [sentence, '', ''];
  return [sentence.slice(0, at), sentence.slice(at, at + match.length), sentence.slice(at + match.length)];
}

export function SearchPanel({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Match[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const router = useRouter();

  useEffect(() => {
    void api.projects
      .list()
      .then((rows) => setNames(new Map(rows.map((p) => [p.id, p.name]))))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const typed = q.trim();
    if (!typed) {
      setHits([]);
      return;
    }
    // A pause, so a search does not run on every keystroke.
    const wait = setTimeout(() => {
      void request(`/api/workbench/search?q=${encodeURIComponent(typed)}`)
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: Match[]) => setHits(rows))
        .catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(wait);
  }, [q]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-8" data-testid="search-panel">
      <div className="w-full max-w-3xl overflow-hidden rounded-lg border border-border/60 bg-background shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border/60 p-3">
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input
            autoFocus
            data-testid="search-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search every conversation…"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none"
          />
          <Button size="xs" variant="ghost" data-testid="search-close" aria-label="Close" onClick={onClose}>
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {hits.map((h) => {
            const [before, hit, after] = split(h.sentence, h.match);
            return (
              <button
                key={`${h.sessionId}:${h.messageId}`}
                type="button"
                data-testid="search-hit"
                data-session-id={h.sessionId}
                className="block w-full border-b border-border/40 px-4 py-3 text-left last:border-b-0 hover:bg-accent"
                onClick={() => {
                  onClose();
                  router.push(
                    `/project?id=${encodeURIComponent(h.projectId)}&tab=chat&chat=${encodeURIComponent(h.sessionId)}`,
                  );
                }}
              >
                <div className="text-sm text-foreground">
                  {before}
                  <mark data-testid="search-mark" className="rounded bg-amber-400/30 px-0.5 text-foreground">
                    {hit}
                  </mark>
                  {after}
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span data-testid="search-project" className="font-medium">
                    {names.get(h.projectId) ?? 'Unknown project'}
                  </span>
                  <span className="truncate">· {h.title ?? 'Untitled chat'}</span>
                  <span className="ml-auto shrink-0 font-mono">{new Date(h.at).toLocaleString()}</span>
                </div>
              </button>
            );
          })}
          {q.trim() && !hits.length && (
            <p className="px-4 py-6 text-sm text-muted-foreground">Nothing said that.</p>
          )}
        </div>
      </div>
    </div>
  );
}
