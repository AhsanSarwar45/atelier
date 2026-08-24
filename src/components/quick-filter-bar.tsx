'use client';

import * as React from 'react';
import type { CSSProperties } from 'react';

import { Search, X, ArrowUpDown, SlidersHorizontal, AlertTriangle, Plus, Shapes, Tag } from 'lucide-react';

import { Toolbar } from '@/components/shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/components/ui/tooltip';
import { LABEL_NAMESPACES, LABEL_NAMESPACE_TITLES, parseLabel, tagHue } from '@/lib/bead-labels';
import type { LabelNamespace } from '@/lib/bead-labels';
import { ISSUE_TYPES, getIssueTypeMeta } from '@/lib/issue-types';
import type { IssueTypeFilter } from '@/lib/issue-types';
import { cn } from '@/lib/utils';
import { STATES, type BeadStatus } from '@/types';

type TypeFilter = IssueTypeFilter;
type SortField = 'ticket_number' | 'created_at';
type SortDirection = 'asc' | 'desc';

interface QuickFilterBarProps {
  /** Issue type filter: all, epics, or tasks */
  typeFilter: TypeFilter;
  /** Callback when type filter changes */
  onTypeFilterChange: (type: TypeFilter) => void;
  /** Whether to show only today's active items */
  todayOnly: boolean;
  /** Callback when today's active toggle changes */
  onTodayOnlyChange: (value: boolean) => void;
  /** Field to sort by */
  sortField: SortField;
  /** Sort direction */
  sortDirection: SortDirection;
  /** Callback when sort changes */
  onSortChange: (field: SortField, direction: SortDirection) => void;
  /** Search query */
  search: string;
  /** Callback when search changes */
  onSearchChange: (value: string) => void;
  /** Ref for the search input (keyboard navigation) */
  searchInputRef?: React.RefObject<HTMLInputElement>;
  /** Active status filters */
  statuses: BeadStatus[];
  /** Callback when status filter toggles */
  onStatusToggle: (status: BeadStatus) => void;
  /** Active owner filters */
  owners: string[];
  /** Callback when owner filter toggles */
  onOwnerToggle: (owner: string) => void;
  /** List of available owners */
  availableOwners: string[];
  /** Active tag filters as raw labels (`area:board`) */
  tags: string[];
  /** Callback when a tag filter toggles */
  onTagToggle: (tag: string) => void;
  /** Callback that drops every tag filter */
  onTagsClear: () => void;
  /** Tag values present on the board, per namespace */
  availableTags: Record<LabelNamespace, string[]>;
  /** Callback to clear all filters */
  onClearFilters: () => void;
  /** Whether any filters are active */
  hasActiveFilters: boolean;
  /** Count of beads with truly unknown statuses */
  unknownStatusCount?: number;
  /** List of unknown status names for tooltip */
  unknownStatusNames?: string[];
  /** Callback when "New" button is clicked */
  onNewBead?: () => void;
}

const SORT_OPTIONS: { value: string; label: string; field: SortField; direction: SortDirection }[] = [
  { value: 'ticket_number_desc', label: 'Ticket # (Newest)', field: 'ticket_number', direction: 'desc' },
  { value: 'ticket_number_asc', label: 'Ticket # (Oldest)', field: 'ticket_number', direction: 'asc' },
  { value: 'created_at_desc', label: 'Updated (Newest)', field: 'created_at', direction: 'desc' },
  { value: 'created_at_asc', label: 'Updated (Oldest)', field: 'created_at', direction: 'asc' },
];

const STATUS_OPTIONS: { value: BeadStatus; label: string }[] =
  STATES.map((s) => ({ value: s.id, label: s.label }));

/**
 * QuickFilterBar provides quick access to common filter and sort operations
 * for the kanban board. Displays below the header as a horizontal bar.
 */
export function QuickFilterBar({
  typeFilter,
  onTypeFilterChange,
  todayOnly,
  onTodayOnlyChange,
  sortField,
  sortDirection,
  onSortChange,
  search,
  onSearchChange,
  searchInputRef,
  statuses,
  onStatusToggle,
  owners,
  onOwnerToggle,
  availableOwners,
  tags,
  onTagToggle,
  onTagsClear,
  availableTags,
  onClearFilters,
  hasActiveFilters,
  unknownStatusCount = 0,
  unknownStatusNames = [],
  onNewBead,
}: QuickFilterBarProps) {
  const currentSortValue = `${sortField}_${sortDirection}`;

  // Active issue-type filter metadata for the type dropdown trigger
  const activeType = typeFilter === 'all' ? null : getIssueTypeMeta(typeFilter);
  const TypeTriggerIcon = activeType?.icon ?? Shapes;

  const tagTriggerLabel =
    tags.length === 0
      ? 'All tags'
      : tags.length === 1
        ? (parseLabel(tags[0])?.value ?? tags[0])
        : `${tags.length} tags`;

  const handleSortOptionSelect = (value: string) => {
    const option = SORT_OPTIONS.find((opt) => opt.value === value);
    if (option) {
      onSortChange(option.field, option.direction);
    }
  };

  return (
    // Nothing on this row is allowed to be squeezed. A flex child shrinks by
    // default, so on a phone the eleven controls here did not overflow the row
    // — they compressed inside it, and a row that does not overflow does not
    // scroll, which is how New and the filters ended up both invisible and
    // unreachable at 390 wide (bw-81wt.4).
    <Toolbar label="Quick filters" className="[&>*]:shrink-0">
      {/* Search Input */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-t-muted" aria-hidden="true" />
        <Input
          ref={searchInputRef}
          type="text"
          aria-label="Search cards"
          placeholder="Search… (/)"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-8 pr-8 w-[9.5rem] sm:w-[180px] h-8 bg-surface-overlay/50 border-b-strong text-t-primary placeholder:text-t-muted"
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            className="absolute right-0 top-1/2 -translate-y-1/2 size-11 flex items-center justify-center text-t-muted hover:text-t-secondary"
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* New Bead Button */}
      {onNewBead && (
        <Button
          size="sm"
          onClick={onNewBead}
          className="h-8 px-3 gap-1.5 bg-success text-white hover:bg-success/85 font-medium shadow-sm"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          New
        </Button>
      )}

      {/* Type Filter Dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'h-8 px-3 gap-1.5 bg-surface-overlay/50 text-sm font-medium',
              activeType ? 'text-t-primary' : 'text-t-tertiary hover:text-t-secondary'
            )}
            aria-label="Filter by issue type"
          >
            <TypeTriggerIcon className={cn('size-4 shrink-0', activeType?.colorClass)} aria-hidden="true" />
            {activeType ? activeType.label : 'All types'}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="bg-surface-raised border-b-default">
          <DropdownMenuCheckboxItem
            checked={typeFilter === 'all'}
            onCheckedChange={() => onTypeFilterChange('all')}
            className="text-t-secondary focus:bg-surface-overlay focus:text-t-primary"
          >
            All types
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator className="bg-surface-overlay" />
          {ISSUE_TYPES.map((option) => {
            const Icon = option.icon;
            return (
              <DropdownMenuCheckboxItem
                key={option.value}
                checked={typeFilter === option.value}
                onCheckedChange={() => onTypeFilterChange(option.value)}
                className="text-t-secondary focus:bg-surface-overlay focus:text-t-primary"
              >
                <span className="flex items-center gap-2">
                  <Icon className={cn('size-3.5 shrink-0', option.colorClass)} aria-hidden="true" />
                  {option.label}
                </span>
              </DropdownMenuCheckboxItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Tag Filter Dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'h-8 px-3 gap-1.5 bg-surface-overlay/50 text-sm font-medium',
              tags.length > 0 ? 'text-t-primary' : 'text-t-tertiary hover:text-t-secondary'
            )}
            aria-label="Filter by tag"
          >
            <Tag className="size-4 shrink-0" aria-hidden="true" />
            {tagTriggerLabel}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="bg-surface-raised border-b-default max-h-[60vh] overflow-y-auto">
          <DropdownMenuCheckboxItem
            checked={tags.length === 0}
            onCheckedChange={onTagsClear}
            className="text-t-secondary focus:bg-surface-overlay focus:text-t-primary"
          >
            All tags
          </DropdownMenuCheckboxItem>
          {LABEL_NAMESPACES.map((namespace) => (
            availableTags[namespace].length > 0 && (
              <React.Fragment key={namespace}>
                <DropdownMenuSeparator className="bg-surface-overlay" />
                <DropdownMenuLabel className="text-t-muted text-xs">
                  {LABEL_NAMESPACE_TITLES[namespace]}
                </DropdownMenuLabel>
                {availableTags[namespace].map((value) => {
                  const raw = `${namespace}:${value}`;
                  return (
                    <DropdownMenuCheckboxItem
                      key={raw}
                      checked={tags.includes(raw)}
                      onCheckedChange={() => onTagToggle(raw)}
                      className="text-t-secondary focus:bg-surface-overlay focus:text-t-primary"
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className="bead-tag-dot"
                          style={{ '--tag-h': `${tagHue({ namespace, value, raw })}` } as CSSProperties}
                          aria-hidden="true"
                        />
                        {value}
                      </span>
                    </DropdownMenuCheckboxItem>
                  );
                })}
              </React.Fragment>
            )
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Today's Active Toggle - styled to match tabs */}
      <button
        type="button"
        onClick={() => onTodayOnlyChange(!todayOnly)}
        aria-pressed={todayOnly}
        className={cn(
          'h-8 px-3 text-sm font-medium rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised',
          todayOnly
            ? 'bg-epic/20 text-epic'
            : 'bg-surface-overlay/50 text-t-tertiary hover:text-t-secondary'
        )}
      >
        Today
      </button>

      {/* No Reports button: this bar is the board's own, and reports are a tab
          of the project in the bar above it (bw-7ks.21.14). */}

      {/* Unknown status warning indicator */}
      {unknownStatusCount > 0 && (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="warning" appearance="outline" size="lg" role="status" className="gap-1.5">
                <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
                <span className="tabular-nums">{unknownStatusCount}</span>
                <span className="sr-only">
                  {unknownStatusCount === 1 ? 'card has an' : 'cards have'} unknown {unknownStatusCount === 1 ? 'status' : 'statuses'}
                </span>
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              <p className="font-medium">
                {unknownStatusCount} {unknownStatusCount === 1 ? 'card has an' : 'cards have'} unknown {unknownStatusCount === 1 ? 'status' : 'statuses'}
              </p>
              <p className="text-primary-foreground/70 mt-1">
                {unknownStatusNames.length > 0
                  ? `Unknown: ${unknownStatusNames.join(', ')}`
                  : 'Mapped to Open column'}
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      {/* Spacer to push sort and filter to the right */}
      <div className="flex-1" />

      {/* Sort Icon Menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-t-tertiary hover:text-t-primary"
            aria-label="Sort options"
          >
            <ArrowUpDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="bg-surface-raised border-b-default">
          <DropdownMenuLabel className="text-t-tertiary">Sort by</DropdownMenuLabel>
          <DropdownMenuSeparator className="bg-surface-overlay" />
          {SORT_OPTIONS.map((option) => (
            <DropdownMenuCheckboxItem
              key={option.value}
              checked={currentSortValue === option.value}
              onCheckedChange={() => handleSortOptionSelect(option.value)}
              className="text-t-secondary focus:bg-surface-overlay focus:text-t-primary"
            >
              {option.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Filter Icon Menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'h-8 px-2',
              hasActiveFilters ? 'text-epic' : 'text-t-tertiary hover:text-t-primary'
            )}
            aria-label="Filter options"
          >
            <SlidersHorizontal className="h-4 w-4" />
            {hasActiveFilters && <span className="ml-1 text-xs" aria-hidden="true">•</span>}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56 bg-surface-raised border-b-default">
          <DropdownMenuLabel className="text-t-tertiary">Status</DropdownMenuLabel>
          <DropdownMenuSeparator className="bg-surface-overlay" />
          {STATUS_OPTIONS.map((option) => (
            <DropdownMenuCheckboxItem
              key={option.value}
              checked={statuses.includes(option.value)}
              onCheckedChange={() => onStatusToggle(option.value)}
              className="text-t-secondary focus:bg-surface-overlay focus:text-t-primary"
            >
              {option.label}
            </DropdownMenuCheckboxItem>
          ))}

          {availableOwners.length > 0 && (
            <>
              <DropdownMenuSeparator className="bg-surface-overlay" />
              <DropdownMenuLabel className="text-t-tertiary">Owner</DropdownMenuLabel>
              <DropdownMenuSeparator className="bg-surface-overlay" />
              {availableOwners.map((owner) => (
                <DropdownMenuCheckboxItem
                  key={owner}
                  checked={owners.includes(owner)}
                  onCheckedChange={() => onOwnerToggle(owner)}
                  className="text-t-secondary focus:bg-surface-overlay focus:text-t-primary"
                >
                  {owner}
                </DropdownMenuCheckboxItem>
              ))}
            </>
          )}

          {hasActiveFilters && (
            <>
              <DropdownMenuSeparator className="bg-surface-overlay" />
              <DropdownMenuItem
                onClick={onClearFilters}
                className="text-danger focus:bg-surface-overlay focus:text-danger"
              >
                Clear filters
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </Toolbar>
  );
}

export type { QuickFilterBarProps, TypeFilter, SortField, SortDirection };
