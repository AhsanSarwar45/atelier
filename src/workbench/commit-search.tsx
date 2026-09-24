'use client';

/**
 * The one line the commits pane is searched from (bw-g6zy.4).
 *
 * A box, a button that opens the filters, and a row of chips saying what is
 * currently being asked for. All three read and write the same text, through
 * `commit-query.ts`, so there is no second state to fall out of step with what
 * is on screen — and the query stays something a person can read, edit and
 * paste somewhere else.
 */

import * as React from 'react';

import { Filter, Search, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  type CommitQuery,
  type Qualifier,
  isEmpty,
  readQuery,
  setFilters,
  withQualifier,
} from '@/workbench/commit-query';

/** The date windows worth a press rather than a typed phrase. */
const WHEN: { word: string; since: string }[] = [
  { word: 'Today', since: 'midnight' },
  { word: '7 days', since: '7 days ago' },
  { word: '30 days', since: '30 days ago' },
];

export interface CommitSearchProps {
  /** The line as typed, which is the whole of the query. */
  line: string;
  onLine: (line: string) => void;
  /** How many the current line found, drawn beside the box. */
  found?: number;
  /** Whether an answer is still on its way. */
  reading?: boolean;
}

export function CommitSearch({ line, onLine, found, reading }: CommitSearchProps) {
  const query: CommitQuery = React.useMemo(() => readQuery(line), [line]);
  const filters = setFilters(query);
  const asked = !isEmpty(query);

  const set = (name: Qualifier, value: string | undefined) => {
    onLine(withQualifier(line, name, value));
  };

  return (
    <div className="flex flex-col gap-1.5" data-testid="commit-search">
      <div className="flex items-center gap-1">
        <Input
          size="sm"
          containerClassName="flex-1"
          start={<Search className="text-t-faint" aria-hidden="true" />}
          end={asked ? (
            <Button
              size="xs"
              mode="icon"
              variant="ghost"
              aria-label="Clear the search"
              data-testid="commit-search-clear"
              onClick={() => onLine('')}
            >
              <X aria-hidden="true" />
            </Button>
          ) : undefined}
          value={line}
          onChange={(event) => onLine(event.target.value)}
          placeholder="Search commits"
          aria-label="Search commits"
          data-testid="commit-search-box"
        />
        <Popover>
          <PopoverTrigger asChild>
            <Button
              size="xs"
              mode="icon"
              variant={filters.length > 0 ? 'outline' : 'ghost'}
              aria-label="Filter the commits"
              data-testid="commit-filter-open"
            >
              <Filter aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          {/* Everything here writes a qualifier into the box above rather than
              holding a value of its own, so closing the popover loses nothing
              and the line always says what is being asked for. */}
          <PopoverContent align="end" className="w-64 p-3" data-testid="commit-filter-panel">
            <div className="flex flex-col gap-3">
              <Field
                label="Author"
                placeholder="Any part of a name"
                testId="commit-filter-author"
                value={query.author ?? ''}
                onValue={(value) => set('author', value)}
              />
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium text-t-secondary">Since</span>
                <ToggleGroup
                  type="single"
                  optional
                  variant="outline"
                  aria-label="Since, as a window"
                  className="flex-wrap gap-1"
                  value={query.since ?? ''}
                  // Pressing the window already chosen takes it away again.
                  onValueChange={(since) => set('since', since || undefined)}
                >
                  {WHEN.map((window) => (
                    <ToggleGroupItem
                      key={window.word}
                      value={window.since}
                      data-testid={`commit-filter-since-${window.word.replace(/\s/g, '-')}`}
                    >
                      {window.word}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <Input
                  value={query.since ?? ''}
                  onChange={(event) => set('since', event.target.value)}
                  placeholder="or a date, or 2 weeks ago"
                  aria-label="Since"
                  data-testid="commit-filter-since"
                  size="sm"
                />
              </div>
              <Field
                label="Until"
                placeholder="A date, or yesterday"
                testId="commit-filter-until"
                value={query.until ?? ''}
                onValue={(value) => set('until', value)}
              />
              <Field
                label="Path"
                placeholder="A file or a folder"
                testId="commit-filter-path"
                value={query.path ?? ''}
                onValue={(value) => set('path', value)}
              />
              <Field
                label="Branch"
                placeholder="The line to walk"
                testId="commit-filter-ref"
                value={query.ref ?? ''}
                onValue={(value) => set('ref', value)}
              />
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {(filters.length > 0 || (asked && found !== undefined)) && (
        <div className="flex flex-wrap items-center gap-1" data-testid="commit-search-chips">
          {filters.map((filter) => (
            <Tooltip key={filter.name} label={`${filter.word}: ${filter.value}`}>
              <Badge
                size="sm"
                variant="secondary"
                appearance="light"
                asChild
                data-testid={`commit-chip-${filter.name}`}
              >
                <Button type="button" variant="ghost" size="none" onClick={() => set(filter.name, undefined)}>
                  <span className="max-w-28 truncate">
                    {filter.word}: {filter.value}
                  </span>
                  <X className="shrink-0" aria-hidden="true" />
                  <span className="sr-only">Remove this filter</span>
                </Button>
              </Badge>
            </Tooltip>
          ))}
          {asked && found !== undefined && (
            <span
              className={cn('ml-auto text-[10px] tabular-nums text-t-faint', reading && 'opacity-60')}
              data-testid="commit-search-count"
            >
              {reading ? 'Searching…' : `${found} found`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** One labelled box in the popover, which writes straight into the line. */
function Field({
  label,
  placeholder,
  testId,
  value,
  onValue,
}: {
  label: string;
  placeholder: string;
  testId: string;
  value: string;
  onValue: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium text-t-secondary">{label}</span>
      <Input
        value={value}
        onChange={(event) => onValue(event.target.value)}
        placeholder={placeholder}
        data-testid={testId}
        size="sm"
      />
    </label>
  );
}
