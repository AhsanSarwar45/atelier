'use client';

/**
 * A picker you can type into (bw-ov7a.7).
 *
 * A plain select is fine for three choices and useless for a repository with
 * two hundred branches: the reader knows the name and has to hunt for it. This
 * is the same shape as `Select` — a trigger showing the chosen thing, a list
 * under it — with a filter box at the top, the arrow keys moving through what
 * is left, and Enter taking it.
 *
 * The filtering itself is a plain function, so what "matches" means is proved
 * without drawing anything.
 */

import * as React from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface PickerChoice {
  /** What the choice is worth, and what comes back from `onChange`. */
  value: string;
  /** What the reader sees and types at. */
  label: string;
  /** A second line — a branch, a path, whatever tells two apart. */
  hint?: string;
  /** Anything else worth matching on that is not shown. */
  keywords?: string;
}

/**
 * The choices left after typing `typed`: every word of it has to appear
 * somewhere in the choice, in any order, ignoring case. Nothing typed leaves
 * every choice, in the order they were given.
 */
export function matchingChoices(choices: PickerChoice[], typed: string): PickerChoice[] {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return choices;
  return choices.filter((choice) => {
    const hay = `${choice.label} ${choice.hint ?? ''} ${choice.keywords ?? ''}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

export function Picker({
  choices,
  value,
  onChange,
  placeholder = 'Select',
  searchPlaceholder = 'Search',
  empty = 'Nothing matches',
  label,
  disabled,
  className,
  'data-testid': testId,
}: {
  choices: PickerChoice[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  empty?: string;
  /** What the trigger is called for a reader who cannot see it. */
  label?: string;
  disabled?: boolean;
  className?: string;
  'data-testid'?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const [active, setActive] = React.useState(0);

  const shown = matchingChoices(choices, typed);
  const chosen = choices.find((choice) => choice.value === value) ?? null;

  // A fresh open is a fresh search: what was typed for the last choice is not
  // what the reader means by this one.
  React.useEffect(() => {
    if (!open) return;
    setTyped('');
    setActive(0);
  }, [open]);

  function take(choice: PickerChoice) {
    onChange(choice.value);
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (shown.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((was) => (was + step + shown.length) % shown.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const choice = shown[active];
      if (choice) take(choice);
    }
  }

  return (
    <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        data-testid={testId}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          !chosen && 'text-muted-foreground',
          className,
        )}
      >
        <span className="truncate">
          {chosen ? chosen.label : placeholder}
          {chosen?.hint ? <span className="text-muted-foreground"> {chosen.hint}</span> : null}
        </span>
        <ChevronDown className="size-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        // Above the dialog it is often opened inside — both are z-50, and a
        // list you cannot read is worse than no list. It is at least as wide
        // as the trigger and grows to fit a long branch name.
        className="z-[100] w-auto min-w-[--radix-popover-trigger-width] max-w-80 p-0"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-b-default px-3">
          <Search className="size-3.5 shrink-0 opacity-50" />
          <Input
            autoFocus
            value={typed}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            data-testid={testId ? `${testId}-search` : undefined}
            onChange={(event) => {
              setTyped(event.target.value);
              setActive(0);
            }}
            className="h-9 border-0 px-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <div role="listbox" className="max-h-64 overflow-y-auto p-1">
          {shown.length === 0 && (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground" data-testid={testId ? `${testId}-empty` : undefined}>
              {empty}
            </p>
          )}
          {shown.map((choice, index) => (
            <button
              key={choice.value}
              type="button"
              role="option"
              aria-selected={choice.value === value}
              // The mouse and the arrow keys point at the same row, so moving
              // one does not leave the other highlighting something else.
              onMouseEnter={() => setActive(index)}
              onClick={() => take(choice)}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
                index === active && 'bg-surface-overlay',
              )}
            >
              <Check
                className={cn('size-3.5 shrink-0', choice.value === value ? 'opacity-100' : 'opacity-0')}
              />
              <span className="truncate">{choice.label}</span>
              {choice.hint ? (
                <span className="ml-auto truncate text-xs text-muted-foreground">{choice.hint}</span>
              ) : null}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
