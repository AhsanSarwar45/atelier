/**
 * One search box, for whatever is being searched (bw-21a2.6).
 *
 * The box is the query: `title:loader -codex after:7d`. The controls under it
 * write those same words, and are drawn from them, so the owner can type,
 * click, or both. A source — the chats, the board, the files — says what its
 * keys are, finds a page of matches and draws each with the places in it that
 * matched (source.ts); this draws the box, the controls, the list and the keys
 * that move through it. A switch beside the box hands the search to an agent
 * asked in plain words instead (ask.tsx).
 */
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { ChevronDown, Search as SearchIcon, Sparkles, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Overlay, overlayPanel } from '@/components/ui/overlay';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Row } from '@/components/ui/row';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { Ask } from '@/search/ask';
import type { Choice, Found, Page, Place, SearchSource, Segment } from '@/search/source';
import { controlsOf, suggestionsFor, taking, withFilter, withScopes } from '@/search/syntax';

/** Words with the matched ones marked. */
export function Marked({ segments }: { segments: Segment[] }) {
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

function FilterMenu({
  label,
  value,
  choices,
  testId,
  onChange,
}: {
  label: string;
  value: string | null;
  choices: Choice[];
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

export function Search<Item, Thing extends Found = Found>({
  source,
  onClose,
}: {
  source: SearchSource<Item, Thing>;
  onClose: () => void;
}) {
  const { words } = source;
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(words.sorts[0]?.value ?? '');
  const [page, setPage] = useState<Page<Item>>({ items: [], next: null });
  const [searched, setSearched] = useState(false);
  const [active, setActive] = useState(0);
  const [mode, setMode] = useState<'words' | 'ai'>('words');
  const box = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const asked = useRef(0);
  // The latest way to find, without a new search each time a source redraws.
  const find = useRef(words.find);
  useEffect(() => {
    find.current = words.find;
  }, [words.find]);

  const look = (typed: string, order: string, cursor: number) => {
    const mine = ++asked.current;
    return find
      .current(typed, order, cursor)
      .catch((): Page<Item> => ({ items: [], next: null }))
      .then((found) => {
        if (mine !== asked.current) return;
        setPage((had) => (cursor ? { ...found, items: [...had.items, ...found.items] } : found));
        setSearched(true);
        if (!cursor) setActive(0);
      });
  };

  useEffect(() => {
    if (!q.trim()) {
      asked.current += 1;
      setPage({ items: [], next: null });
      setSearched(false);
      return;
    }
    // A pause, so a search does not run on every keystroke.
    const wait = setTimeout(() => void look(q, sort, 0), 200);
    return () => clearTimeout(wait);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, sort]);

  const scopeKeys = useMemo(() => words.scopes.map((s) => s.value), [words.scopes]);
  const filterKeys = useMemo(() => words.filters.map((f) => f.key), [words.filters]);
  const controls = useMemo(
    () => controlsOf(q, words.grammar, scopeKeys, filterKeys),
    [q, words.grammar, scopeKeys, filterKeys],
  );
  const suggestions = useMemo(() => suggestionsFor(q, words.grammar), [q, words.grammar]);

  const groups = useMemo(() => words.groups(page.items), [words, page.items]);
  const choices = useMemo<Place[]>(() => groups.flatMap((group) => [group.head, ...group.places]), [groups]);

  useEffect(() => {
    list.current?.querySelector(`[data-choice="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const change = (text: string) => {
    setQ(text);
    box.current?.focus();
  };

  const open = (place: Place) => {
    onClose();
    place.open();
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

  const toggleScope = (scope: string) => {
    const now = controls.scopes.includes(scope)
      ? controls.scopes.filter((s) => s !== scope)
      : [...controls.scopes, scope];
    change(withScopes(q, words.grammar, now));
  };

  // One switch between the two ways of looking; a search in words is typed and
  // answered as you go, a question for the AI is asked with Enter.
  const modes = (
    <>
      <Tabs value={mode} onValueChange={(value) => setMode(value === 'ai' ? 'ai' : 'words')}>
        <TabsList aria-label="Search mode" className="h-8 shrink-0 sm:h-8">
          {(
            [
              { value: 'words', label: 'Search', icon: <SearchIcon className="h-3.5 w-3.5" aria-hidden="true" /> },
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

  const row = (place: Place, index: number) => (
    <Row
      key={place.key}
      inset="lg"
      selected={active === index}
      data-choice={index}
      data-testid={place.testId}
      {...place.attrs}
      onMouseMove={() => setActive(index)}
      onClick={() => open(place)}
      className={place.className}
    >
      {place.body}
    </Row>
  );

  let index = -1;
  return (
    <Overlay testId="search-panel" label={words.label} onClose={onClose}>
      <div className={cn(overlayPanel, 'max-w-3xl')}>
        {mode === 'ai' ? (
          <Ask source={source.ask} onClose={onClose} aside={modes} />
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
                  placeholder={words.placeholder}
                  aria-label={words.label}
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
                {words.scopes.length > 0 && (
                  <div role="group" aria-label="Look in" className="flex items-center gap-0.5">
                    {words.scopes.map((scope) => {
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
                )}
                {words.scopes.length > 0 && words.filters.length > 0 && (
                  <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
                )}
                {words.filters.map((filter) => (
                  <FilterMenu
                    key={filter.key}
                    label={filter.label}
                    value={controls.filters[filter.key] ?? null}
                    choices={filter.choices}
                    testId={`search-filter-${filter.key}`}
                    onChange={(value) => change(withFilter(q, words.grammar, filter.key, value))}
                  />
                ))}
                {words.sorts.length > 1 && (
                  <div role="group" aria-label="Order" className="ml-auto flex items-center gap-0.5">
                    {words.sorts.map((order) => (
                      <Button
                        key={order.value}
                        size="xs"
                        variant={sort === order.value ? 'secondary' : 'ghost'}
                        aria-pressed={sort === order.value}
                        data-testid={`search-sort-${order.value}`}
                        onClick={() => setSort(order.value)}
                      >
                        {order.label}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* On a phone the panel is the screen, so the results take whatever
                is left under the box you type in. On a desktop it stays the
                content-sized card it was. */}
            <div ref={list} data-testid="search-results" className="min-h-0 flex-1 overflow-y-auto sm:max-h-[60vh] sm:flex-none">
              {!q.trim() && (
                <div className="flex flex-wrap gap-1 p-3">
                  {words.starters.map((starter) => (
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

              {groups.map((group) => (
                <div key={group.key} data-testid={group.testId} {...group.attrs} className="border-b border-border/40 py-1 last:border-b-0">
                  {row(group.head, ++index)}
                  {group.places.map((place) => row(place, ++index))}
                </div>
              ))}

              {page.next !== null && (
                <div className="p-2 text-center">
                  <Button size="xs" variant="ghost" data-testid="search-more" onClick={() => void look(q, sort, page.next!)}>
                    More
                  </Button>
                </div>
              )}
              {q.trim() && searched && !page.items.length && (
                <p data-testid="search-nothing" className="px-4 py-6 text-sm text-muted-foreground">
                  {words.nothing}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}
