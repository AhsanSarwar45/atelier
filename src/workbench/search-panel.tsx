/**
 * One search across every conversation, in every project.
 *
 * The box is the query: `title:loader me:"why does" -codex after:7d`. The
 * controls under it write those same words, and are drawn from them, so the
 * owner can type, click, or both. Each chat is listed once with the places in
 * it that matched, the words themselves marked, and opening one of those
 * places opens the chat at it (docs/agent-workbench.md §8.4e). The box, the
 * controls and the AI search are shared with every search (src/search); this
 * is the chats as a source.
 */
'use client';

import { useEffect, useMemo, useState } from 'react';

import { useRouter } from 'next/navigation';

import * as api from '@/lib/api';
import { Excerpt, Heading, PLACE, TITLE } from '@/search/parts';
import { Marked, Search } from '@/search/search';
import type { FilterSpec, Found, SearchSource, Segment } from '@/search/source';
import { CHAT_GRAMMAR, SCOPES } from '@/workbench/search-syntax';

export type { Segment } from '@/search/source';

export interface Snippet {
  messageId: string;
  field: 'me' | 'agent' | 'tool';
  at: string;
  segments: Segment[];
}

export interface ChatMatch {
  sessionId: string;
  title: string | null;
  titleSegments: Segment[] | null;
  projectId: string;
  projectPath: string;
  brand: string;
  origin: string;
  lastActiveAt: string;
  matches: number;
  snippets: Snippet[];
}

/** A chat an agent found. */
export interface FoundChat extends Found {
  sessionId: string;
  title: string | null;
  projectId: string;
  projectPath: string;
  brand: string;
  lastActiveAt: string;
}

const SAID_BY: Record<Snippet['field'], string> = { me: 'You', agent: 'Agent', tool: 'Tool' };

const FILTERS: FilterSpec[] = [
  {
    key: 'provider',
    label: 'Provider',
    choices: [
      { value: 'claude', label: 'Claude' },
      { value: 'codex', label: 'Codex' },
      { value: 'local', label: 'Local' },
    ],
  },
  {
    key: 'after',
    label: 'When',
    choices: [
      { value: 'today', label: 'Today' },
      { value: '7d', label: 'Past week' },
      { value: '30d', label: 'Past month' },
      { value: '1y', label: 'Past year' },
    ],
  },
  {
    key: 'from',
    label: 'Started in',
    choices: [
      { value: 'app', label: 'App' },
      { value: 'terminal', label: 'Terminal' },
    ],
  },
];

const TIPS = [{ example: 'after:2026-09-01', meaning: 'Active after date' }];

const folderName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path;

function Meta({ project, brand, at, matches }: { project: string; brand: string; at: string; matches?: number }) {
  return (
    <>
      <span data-testid="search-project" className="max-w-40 truncate">{project}</span>
      <span>·</span>
      <span className="capitalize">{brand}</span>
      <span>·</span>
      <span className="font-mono">{new Date(at).toLocaleDateString()}</span>
      {!!matches && (
        <span data-testid="search-chat-matches" className="rounded bg-muted px-1 font-mono">
          {matches}
        </span>
      )}
    </>
  );
}

/** The chats, as the shared search draws and opens them. */
export function useChatSearch(): SearchSource<ChatMatch, FoundChat> {
  const router = useRouter();
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    void api.projects
      .list()
      .then((rows) => setProjects(rows.map((p) => ({ id: p.id, name: p.name }))))
      .catch(() => undefined);
  }, []);

  return useMemo(() => {
    const names = new Map(projects.map((p) => [p.id, p.name]));
    const project = (id: string, path: string) => names.get(id) ?? folderName(path);
    const go = (projectId: string, sessionId: string, messageId: string | null) => {
      const at = messageId ? `&message=${encodeURIComponent(messageId)}` : '';
      router.push(`/project?id=${encodeURIComponent(projectId)}&tab=chat&chat=${encodeURIComponent(sessionId)}${at}`);
    };
    return {
      words: {
        label: 'Search chats',
        placeholder: 'Search chats…',
        nothing: 'No chats.',
        grammar: { ...CHAT_GRAMMAR, values: { ...CHAT_GRAMMAR.values, project: projects.map((p) => p.name) } },
        scopes: SCOPES,
        filters: [
          { key: 'project', label: 'Project', choices: projects.map((p) => ({ value: p.name, label: p.name })) },
          ...FILTERS,
        ],
        tips: TIPS,
        sorts: [
          { value: 'relevance', label: 'Best' },
          { value: 'newest', label: 'Newest' },
        ],
        find: async (q, sort, cursor) => {
          const address = `/api/workbench/search/chats?q=${encodeURIComponent(q)}&sort=${sort}&cursor=${cursor}`;
          const answer = await api.request(address);
          if (!answer.ok) return { items: [], next: null };
          const page = (await answer.json()) as { chats: ChatMatch[]; next: number | null };
          return { items: page.chats, next: page.next };
        },
        groups: (chats) =>
          chats.map((chat) => ({
            key: chat.sessionId,
            testId: 'search-chat',
            attrs: { 'data-session-id': chat.sessionId },
            head: {
              key: chat.sessionId,
              testId: 'search-chat-open',
              open: () => go(chat.projectId, chat.sessionId, null),
              body: (
                <Heading
                  title={
                    <span data-testid="search-chat-title" className={TITLE}>
                      {chat.titleSegments ? <Marked segments={chat.titleSegments} /> : (chat.title ?? 'Untitled chat')}
                    </span>
                  }
                  meta={
                    <Meta
                      project={project(chat.projectId, chat.projectPath)}
                      brand={chat.brand}
                      at={chat.lastActiveAt}
                      matches={chat.matches}
                    />
                  }
                />
              ),
            },
            places: chat.snippets.map((snippet) => ({
              key: snippet.messageId,
              testId: 'search-hit',
              attrs: { 'data-session-id': chat.sessionId, 'data-message-id': snippet.messageId },
              className: PLACE,
              open: () => go(chat.projectId, chat.sessionId, snippet.messageId),
              body: (
                <Excerpt label={SAID_BY[snippet.field]} mono={snippet.field === 'tool'}>
                  <Marked segments={snippet.segments} />
                </Excerpt>
              ),
            })),
          })),
      },
      ask: {
        label: 'Ask about chats',
        placeholder: 'Ask about chats…',
        nothing: 'No chats.',
        url: '/api/workbench/search/ask',
        row: (chat) => ({
          key: chat.sessionId,
          testId: 'ai-search-chat',
          attrs: { 'data-session-id': chat.sessionId },
          open: () => go(chat.projectId, chat.sessionId, chat.at),
          body: (
            <Heading
              title={<span className={TITLE}>{chat.title ?? 'Untitled chat'}</span>}
              meta={<Meta project={project(chat.projectId, chat.projectPath)} brand={chat.brand} at={chat.lastActiveAt} />}
            />
          ),
        }),
      },
    };
  }, [projects, router]);
}

export function SearchPanel({ onClose }: { onClose: () => void }) {
  const source = useChatSearch();
  return <Search source={source} onClose={onClose} />;
}
