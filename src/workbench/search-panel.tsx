/**
 * One search across every conversation, in every project.
 *
 * The box is the query: `title:loader me:"why does" -codex after:7d`. The
 * controls under it write those same words, and are drawn from them, so the
 * owner can type, click, or both. Each chat is listed once with the places in
 * it that matched, the words themselves marked, and opening one of those
 * places opens the chat at it (docs/agent-workbench.md §8.4e).
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useRouter } from 'next/navigation';

import { ChevronDown, Search, Sparkles, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Overlay, overlayPanel } from '@/components/ui/overlay';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Row } from '@/components/ui/row';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import * as api from '@/lib/api';
import { cn } from '@/lib/utils';
import { AiSearch } from '@/workbench/ai-search';
import {
  type Filter,
  SCOPES,
  type Scope,
  controlsOf,
  suggestionsFor,
  taking,
  withFilter,
  withScopes,
} from '@/workbench/search-syntax';

export interface Segment {
  text: string;
  mark?: boolean;
}

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

interface Page {
  chats: ChatMatch[];
  next: number | null;
  ignored?: string[];
}

type Sort = 'relevance' | 'newest';

/** One thing Enter can open: a chat, or one place in it. */
interface Choice {
  chat: ChatMatch;
  snippet: Snippet | null;
}

const SAID_BY: Record<Snippet['field'], string> = { me: 'You', agent: 'Agent', tool: 'Tool' };

const FILTERS: { key: Exclude<Filter, 'in'>; label: string; choices: { value: string; label: string }[] }[] = [
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

const STARTERS = ['title:', 'me:', 'agent:', 'tool:', 'project:', 'after:'];

function Marked({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((segment, i) =>
        segment.mark ? (
          <mark key={i} data-testid="search-mark" className="rounded bg-amber-400/30 px-0.5 text-foreground">
            {segment.text}
          </mark>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </>
  );
}

const folderName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path;

function FilterMenu({
  label,
  value,
  choices,
  testId,
  onChange,
}: {
  label: string;
  value: string | null;
  choices: { value: string; label: string }[];
  testId: string;
  onChange: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const shown = value ? (choices.find((c) => c.value.toLowerCase() === value.toLowerCase())?.label ?? value) : label;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="xs"
          variant={value ? 'secondary' : 'ghost'}
          data-testid={testId}
          data-value={value ?? undefined}
          className="gap-1"
        >
          <span className="max-w-32 truncate">{shown}</span>
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-72 w-48 overflow-y-auto p-1">
        <Row
          inset="md"
          radius="md"
          selected={!value}
          data-testid={`${testId}-any`}
          onClick={() => {
            onChange(null);
            setOpen(false);
          }}
        >
          <span className="text-sm">Any</span>
        </Row>
        {choices.map((choice) => (
          <Row
            key={choice.value}
            inset="md"
            radius="md"
            selected={value?.toLowerCase() === choice.value.toLowerCase()}
            data-testid={`${testId}-choice`}
            onClick={() => {
              onChange(choice.value);
              setOpen(false);
            }}
          >
            <span className="truncate text-sm">{choice.label}</span>
          </Row>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function SearchPanel({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('relevance');
  const [page, setPage] = useState<Page>({ chats: [], next: null });
  const [searched, setSearched] = useState(false);
  const [active, setActive] = useState(0);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [mode, setMode] = useState<'words' | 'ai'>('words');
  const box = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const asked = useRef(0);
  const router = useRouter();

  useEffect(() => {
    void api.projects
      .list()
      .then((rows) => setProjects(rows.map((p) => ({ id: p.id, name: p.name }))))
      .catch(() => undefined);
  }, []);
  const names = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);

  const ask = useCallback(
    (typed: string, order: Sort, cursor: number) => {
      const mine = ++asked.current;
      const address = `/api/workbench/search/chats?q=${encodeURIComponent(typed)}&sort=${order}&cursor=${cursor}`;
      return api
        .request(address)
        .then((r) => (r.ok ? (r.json() as Promise<Page>) : { chats: [], next: null }))
        .catch(() => ({ chats: [], next: null }) as Page)
        .then((found) => {
          if (mine !== asked.current) return;
          setPage((had) => (cursor ? { ...found, chats: [...had.chats, ...found.chats] } : found));
          setSearched(true);
          if (!cursor) setActive(0);
        });
    },
    [],
  );

  useEffect(() => {
    if (!q.trim()) {
      asked.current += 1;
      setPage({ chats: [], next: null });
      setSearched(false);
      return;
    }
    // A pause, so a search does not run on every keystroke.
    const wait = setTimeout(() => void ask(q, sort, 0), 200);
    return () => clearTimeout(wait);
  }, [q, sort, ask]);

  const controls = useMemo(() => controlsOf(q), [q]);
  const suggestions = useMemo(() => suggestionsFor(q, projects.map((p) => p.name)), [q, projects]);

  const choices = useMemo<Choice[]>(
    () =>
      page.chats.flatMap((chat) => [
        { chat, snippet: null },
        ...chat.snippets.map((snippet) => ({ chat, snippet })),
      ]),
    [page.chats],
  );

  useEffect(() => {
    list.current?.querySelector(`[data-choice="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const change = (text: string) => {
    setQ(text);
    box.current?.focus();
  };

  const open = (choice: Choice) => {
    onClose();
    const { chat, snippet } = choice;
    const at = snippet ? `&message=${encodeURIComponent(snippet.messageId)}` : '';
    router.push(
      `/project?id=${encodeURIComponent(chat.projectId)}&tab=chat&chat=${encodeURIComponent(chat.sessionId)}${at}`,
    );
  };

  const keyed = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && choices.length) {
      event.preventDefault();
      setActive((i) => Math.min(choices.length - 1, i + 1));
    } else if (event.key === 'ArrowUp' && choices.length) {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === 'Enter' && choices[active]) {
      event.preventDefault();
      open(choices[active]!);
    } else if (event.key === 'Tab' && !event.shiftKey && suggestions) {
      event.preventDefault();
      setQ(taking(q, suggestions, suggestions.items[0]!));
    }
  };

  const toggleScope = (scope: Scope) => {
    const now = controls.scopes.includes(scope)
      ? controls.scopes.filter((s) => s !== scope)
      : [...controls.scopes, scope];
    change(withScopes(q, now));
  };

  // One switch between the two ways of looking; a search in words is typed and
  // answered as you go, a question for the AI is asked with Enter.
  const modes = (
    <>
      <Tabs value={mode} onValueChange={(value) => setMode(value === 'ai' ? 'ai' : 'words')}>
        <TabsList aria-label="Search mode" className="h-8 shrink-0 sm:h-8">
          {(
            [
              { value: 'words', label: 'Search', icon: <Search className="h-3.5 w-3.5" aria-hidden="true" /> },
              { value: 'ai', label: 'Ask AI', icon: <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> },
            ] as const
          ).map((choice) => (
            <TabsTrigger key={choice.value} value={choice.value} data-testid={`search-mode-${choice.value}`} className="h-6 gap-1.5 px-2 text-xs sm:h-6">
              {choice.icon}
              {choice.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Button size="xs" variant="ghost" data-testid="search-close" aria-label="Close" onClick={onClose}>
        <X className="h-4 w-4" aria-hidden="true" />
      </Button>
    </>
  );

  let index = -1;
  return (
    <Overlay testId="search-panel" label="Search every conversation" onClose={onClose}>
      <div className={cn(overlayPanel, 'max-w-3xl')}>
        {mode === 'ai' ? (
          <AiSearch onClose={onClose} aside={modes} named={(id, path) => names.get(id) ?? folderName(path)} />
        ) : (
        <>
        <div className="border-b border-border/60 p-3">
          <div className="flex items-center gap-2">
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <Input
              ref={box}
              autoFocus
              data-testid="search-input"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={keyed}
              placeholder="Search every conversation…"
              aria-label="Search every conversation"
              spellCheck={false}
              className="min-w-0 flex-1 font-mono text-sm"
            />
            {modes}
          </div>

          {suggestions && (
            <div data-testid="search-suggestions" className="mt-2 flex flex-wrap items-center gap-1">
              {suggestions.items.map((suggestion, i) => (
                <Button
                  key={suggestion.insert}
                  size="xs"
                  variant="outline"
                  data-testid="search-suggestion"
                  className="font-mono"
                  onClick={() => change(taking(q, suggestions, suggestion))}
                >
                  {suggestion.label}
                  {i === 0 && <kbd className="ml-1 text-[10px] text-muted-foreground">Tab</kbd>}
                </Button>
              ))}
            </div>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-1">
            <div role="group" aria-label="Look in" className="flex items-center gap-0.5">
              {SCOPES.map((scope) => {
                const on = controls.scopes.includes(scope.value);
                return (
                  <Button
                    key={scope.value}
                    size="xs"
                    variant={on ? 'secondary' : 'ghost'}
                    aria-pressed={on}
                    data-testid={`search-scope-${scope.value}`}
                    onClick={() => toggleScope(scope.value)}
                  >
                    {scope.label}
                  </Button>
                );
              })}
            </div>
            <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
            <FilterMenu
              label="Project"
              value={controls.project}
              choices={projects.map((p) => ({ value: p.name, label: p.name }))}
              testId="search-filter-project"
              onChange={(value) => change(withFilter(q, 'project', value))}
            />
            {FILTERS.map((filter) => (
              <FilterMenu
                key={filter.key}
                label={filter.label}
                value={controls[filter.key]}
                choices={filter.choices}
                testId={`search-filter-${filter.key}`}
                onChange={(value) => change(withFilter(q, filter.key, value))}
              />
            ))}
            <div role="group" aria-label="Order" className="ml-auto flex items-center gap-0.5">
              {(['relevance', 'newest'] as const).map((order) => (
                <Button
                  key={order}
                  size="xs"
                  variant={sort === order ? 'secondary' : 'ghost'}
                  aria-pressed={sort === order}
                  data-testid={`search-sort-${order}`}
                  onClick={() => setSort(order)}
                >
                  {order === 'relevance' ? 'Best' : 'Newest'}
                </Button>
              ))}
            </div>
          </div>
        </div>

        {/* On a phone the panel is the screen, so the results take whatever
            is left under the box you type in. On a desktop it stays the
            content-sized card it was. */}
        <div ref={list} data-testid="search-results" className="min-h-0 flex-1 overflow-y-auto sm:max-h-[60vh] sm:flex-none">
          {!q.trim() && (
            <div className="flex flex-wrap gap-1 p-3">
              {STARTERS.map((starter) => (
                <Button
                  key={starter}
                  size="xs"
                  variant="outline"
                  className="font-mono"
                  data-testid="search-starter"
                  onClick={() => change(`${q}${q && !/\s$/.test(q) ? ' ' : ''}${starter}`)}
                >
                  {starter}
                </Button>
              ))}
            </div>
          )}

          {page.chats.map((chat) => {
            const chatIndex = ++index;
            const project = names.get(chat.projectId) ?? folderName(chat.projectPath);
            return (
              <div key={chat.sessionId} data-testid="search-chat" data-session-id={chat.sessionId} className="border-b border-border/40 py-1 last:border-b-0">
                <Row
                  inset="lg"
                  selected={active === chatIndex}
                  data-choice={chatIndex}
                  data-testid="search-chat-open"
                  onMouseMove={() => setActive(chatIndex)}
                  onClick={() => open({ chat, snippet: null })}
                >
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span data-testid="search-chat-title" className="min-w-0 truncate text-sm font-medium text-foreground">
                      {chat.titleSegments ? <Marked segments={chat.titleSegments} /> : (chat.title ?? 'Untitled chat')}
                    </span>
                    <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span data-testid="search-project" className="max-w-40 truncate">{project}</span>
                      <span>·</span>
                      <span className="capitalize">{chat.brand}</span>
                      <span>·</span>
                      <span className="font-mono">{new Date(chat.lastActiveAt).toLocaleDateString()}</span>
                      {chat.matches > 0 && (
                        <span data-testid="search-chat-matches" className="rounded bg-muted px-1 font-mono">
                          {chat.matches}
                        </span>
                      )}
                    </span>
                  </div>
                </Row>
                {chat.snippets.map((snippet) => {
                  const snippetIndex = ++index;
                  return (
                    <Row
                      key={snippet.messageId}
                      inset="lg"
                      selected={active === snippetIndex}
                      data-choice={snippetIndex}
                      data-testid="search-hit"
                      data-session-id={chat.sessionId}
                      data-message-id={snippet.messageId}
                      onMouseMove={() => setActive(snippetIndex)}
                      onClick={() => open({ chat, snippet })}
                      className="py-1 pl-8"
                    >
                      <div className="flex min-w-0 gap-2 text-sm">
                        <span className="w-10 shrink-0 text-[11px] leading-5 text-muted-foreground">{SAID_BY[snippet.field]}</span>
                        <span className={cn('min-w-0 break-words text-foreground/90', snippet.field === 'tool' && 'font-mono text-xs leading-5')}>
                          <Marked segments={snippet.segments} />
                        </span>
                      </div>
                    </Row>
                  );
                })}
              </div>
            );
          })}

          {page.next !== null && (
            <div className="p-2 text-center">
              <Button size="xs" variant="ghost" data-testid="search-more" onClick={() => void ask(q, sort, page.next!)}>
                More
              </Button>
            </div>
          )}
          {q.trim() && searched && !page.chats.length && (
            <p data-testid="search-nothing" className="px-4 py-6 text-sm text-muted-foreground">No chats.</p>
          )}
        </div>
        </>
        )}
      </div>
    </Overlay>
  );
}
