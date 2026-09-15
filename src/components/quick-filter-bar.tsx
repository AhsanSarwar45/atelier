'use client';

import * as React from 'react';
import type { CSSProperties } from 'react';

import { Search, X, ArrowUpDown, SlidersHorizontal, AlertTriangle, Plus, Shapes, Tag } from 'lucide-react';

import { HamburgerMenu, Toolbar } from '@/components/shell';
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
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Tooltip } from '@/components/ui/tooltip';
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
  const [searchOpen, setSearchOpen] = React.useState(false);
  const searchPending = React.useRef(false);

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

  const typeItems = (
    <>
      <DropdownMenuCheckboxItem
        checked={typeFilter === 'all'}
        onCheckedChange={() => onTypeFilterChange('all')}
      >
        All types
      </DropdownMenuCheckboxItem>
      <DropdownMenuSeparator />
      {ISSUE_TYPES.map((option) => {
        const Icon = option.icon;
        return (
          <DropdownMenuCheckboxItem
            key={option.value}
            checked={typeFilter === option.value}
            onCheckedChange={() => onTypeFilterChange(option.value)}
          >
            <span className="flex items-center gap-2">
              <Icon className={cn('size-3.5 shrink-0', option.colorClass)} aria-hidden="true" />
              {option.label}
            </span>
          </DropdownMenuCheckboxItem>
        );
      })}
    </>
  );

  const tagItems = (
    <>
      <DropdownMenuCheckboxItem
        checked={tags.length === 0}
        onCheckedChange={onTagsClear}
      >
        All tags
      </DropdownMenuCheckboxItem>
      {LABEL_NAMESPACES.map((namespace) => (
        availableTags[namespace].length > 0 && (
          <React.Fragment key={namespace}>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs">
              {LABEL_NAMESPACE_TITLES[namespace]}
            </DropdownMenuLabel>
            {availableTags[namespace].map((value) => {
              const raw = `${namespace}:${value}`;
              return (
                <DropdownMenuCheckboxItem
                  key={raw}
                  checked={tags.includes(raw)}
                  onCheckedChange={() => onTagToggle(raw)}
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
    </>
  );

  const sortItems = SORT_OPTIONS.map((option) => (
    <DropdownMenuCheckboxItem
      key={option.value}
      checked={currentSortValue === option.value}
      onCheckedChange={() => handleSortOptionSelect(option.value)}
    >
      {option.label}
    </DropdownMenuCheckboxItem>
  ));

  const filterItems = (
    <>
      <DropdownMenuLabel>Status</DropdownMenuLabel>
      <DropdownMenuSeparator />
      {STATUS_OPTIONS.map((option) => (
        <DropdownMenuCheckboxItem
          key={option.value}
          checked={statuses.includes(option.value)}
          onCheckedChange={() => onStatusToggle(option.value)}
        >
          {option.label}
        </DropdownMenuCheckboxItem>
      ))}

      {availableOwners.length > 0 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Owner</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {availableOwners.map((owner) => (
            <DropdownMenuCheckboxItem
              key={owner}
              checked={owners.includes(owner)}
              onCheckedChange={() => onOwnerToggle(owner)}
            >
              {owner}
            </DropdownMenuCheckboxItem>
          ))}
        </>
      )}

      {hasActiveFilters && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={onClearFilters}
            className="text-danger focus:text-danger"
          >
            Clear filters
          </DropdownMenuItem>
        </>
      )}
    </>
  );

  const unknownBadge = unknownStatusCount > 0 && (
    <Tooltip
      side="bottom"
      label={
        <>
          <p className="font-medium">
            {unknownStatusCount} {unknownStatusCount === 1 ? 'card has an' : 'cards have'} unknown {unknownStatusCount === 1 ? 'status' : 'statuses'}
          </p>
          <p className="mt-1 text-t-secondary">
            {unknownStatusNames.length > 0
              ? `Unknown: ${unknownStatusNames.join(', ')}`
              : 'Mapped to Todo column'}
          </p>
        </>
      }
    >
      <Badge variant="warning" appearance="outline" size="lg" role="status" className="gap-1.5">
        <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
        <span className="tabular-nums">{unknownStatusCount}</span>
        <span className="sr-only">
          {unknownStatusCount === 1 ? 'card has an' : 'cards have'} unknown {unknownStatusCount === 1 ? 'status' : 'statuses'}
        </span>
      </Badge>
    </Tooltip>
  );

  const searchField = (autoFocus: boolean) => (
    <div className="relative">
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-t-muted" aria-hidden="true" />
      <Input
        ref={autoFocus ? undefined : searchInputRef}
        type="text"
        aria-label="Search cards"
        placeholder={autoFocus ? 'Search cards…' : 'Search… (/)'}
        value={search}
        autoFocus={autoFocus}
        onChange={(e) => onSearchChange(e.target.value)}
        className={cn('h-8 pl-8 pr-8', autoFocus ? 'w-full' : 'w-[180px]')}
      />
      {search && (
        <Button
          type="button"
          variant="dim"
          mode="icon"
          size="sm"
          onClick={() => onSearchChange('')}
          aria-label="Clear search"
          className="absolute right-0 top-1/2 h-11 w-11 -translate-y-1/2"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );

  return (
    // Nothing on this row is allowed to be squeezed: a flex child shrinks by
    // default, and a row that compresses instead of overflowing hid New and the
    // filters at 390 wide (bw-81wt.4). Under the `md` break the row holds only
    // New and the app's one hamburger; everything else folds into that menu, so
    // no control on a phone sits off the edge of the screen.
    <Toolbar label="Quick filters" className="[&>*]:shrink-0">
      <div className="hidden md:block">{searchField(false)}</div>

      {onNewBead && (
        <Button
          size="sm"
          onClick={onNewBead}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          New
        </Button>
      )}

      <div className="hidden items-center gap-2 md:flex">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              selected={!!activeType}
              aria-label="Filter by issue type"
            >
              <TypeTriggerIcon className={cn('size-4 shrink-0', activeType?.colorClass)} aria-hidden="true" />
              {activeType ? activeType.label : 'All types'}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">{typeItems}</DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              selected={tags.length > 0}
              aria-label="Filter by tag"
            >
              <Tag className="size-4 shrink-0" aria-hidden="true" />
              {tagTriggerLabel}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-[60vh] overflow-y-auto">
            {tagItems}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Today's active only — on and off are the library's own two states. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          selected={todayOnly}
          aria-pressed={todayOnly}
          onClick={() => onTodayOnlyChange(!todayOnly)}
        >
          Today
        </Button>
      </div>

      {unknownBadge}

      {/* Spacer to push sort and filter to the right */}
      <div className="flex-1" />

      <div className="hidden items-center gap-2 md:flex">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              mode="icon"
              size="sm"
              aria-label="Sort options"
            >
              <ArrowUpDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {sortItems}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              selected={hasActiveFilters}
              aria-label="Filter options"
            >
              <SlidersHorizontal className="h-4 w-4" />
              {hasActiveFilters && <span className="text-xs" aria-hidden="true">•</span>}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">{filterItems}</DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* A phone: the same controls, folded into the app's one hamburger. The
          search opens as its own popup, anchored to the menu it came from. */}
      <Popover open={searchOpen} onOpenChange={setSearchOpen}>
        <PopoverAnchor asChild>
          <div className="md:hidden">
            <HamburgerMenu
              label="Board options"
              data-testid="board-menu"
              contentTestId="board-menu-items"
              active={!!search || !!activeType || tags.length > 0 || todayOnly || hasActiveFilters}
              onCloseAutoFocus={(event: Event) => {
                // Opening the search from the menu: focus goes to the search
                // box, not back to the button the menu closed onto.
                if (searchPending.current) {
                  event.preventDefault();
                  searchPending.current = false;
                  setSearchOpen(true);
                }
              }}
            >
              <DropdownMenuItem onSelect={() => { searchPending.current = true; }}>
                <Search aria-hidden="true" />
                <span className="truncate">{search ? `Search: ${search}` : 'Search'}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <TypeTriggerIcon className={cn(activeType?.colorClass)} aria-hidden="true" />
                  {activeType ? activeType.label : 'All types'}
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent>{typeItems}</DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Tag aria-hidden="true" />
                  {tagTriggerLabel}
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent className="max-h-[60vh] overflow-y-auto">{tagItems}</DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
              <DropdownMenuCheckboxItem
                checked={todayOnly}
                onCheckedChange={(value) => onTodayOnlyChange(value === true)}
              >
                Today
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <ArrowUpDown aria-hidden="true" />
                  Sort
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent>{sortItems}</DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <SlidersHorizontal aria-hidden="true" />
                  Filter
                  {hasActiveFilters && <span className="text-xs" aria-hidden="true">•</span>}
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent className="w-56">{filterItems}</DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
            </HamburgerMenu>
          </div>
        </PopoverAnchor>
        <PopoverContent align="end" className="w-[min(20rem,calc(100vw-1.5rem))] p-2">
          {searchField(true)}
        </PopoverContent>
      </Popover>
    </Toolbar>
  );
}

export type { QuickFilterBarProps, TypeFilter, SortField, SortDirection };
