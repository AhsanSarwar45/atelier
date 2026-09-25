/**
 * The list-and-detail frame the agent guidance tabs share.
 *
 * A library is a set of documents the reader browses and then reads one of, so
 * each tab is a narrow list of names on the left and the chosen document on
 * the right. The list stays in view while the document scrolls. On a phone the
 * two are one screen at a time: the list, then the document with a way back.
 */
'use client';

import { useState, type ReactNode } from 'react';
import { ArrowLeft, MoreHorizontal, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel } from '@/components/ui/panel';
import { Row } from '@/components/ui/row';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { MarkdownBody } from '@/components/markdown-body';
import { cn } from '@/lib/utils';

export type Tone = 'good' | 'quiet' | 'warn' | 'bad';

const dots: Record<Tone, string> = {
  good: 'bg-[var(--color-success-accent)]',
  quiet: 'bg-t-muted/50',
  warn: 'bg-[var(--color-warning-accent)]',
  bad: 'bg-destructive',
};

export function StateDot({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden="true" className={cn('inline-block size-1.5 shrink-0 rounded-full', dots[tone], className)} />;
}

/** The two panes. `open` says which one a phone shows. */
export function MasterDetail({ list, detail, open, label }: { list: ReactNode; detail: ReactNode; open: boolean; label: string }) {
  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <nav aria-label={label} className={cn('min-w-0 lg:sticky lg:top-0 lg:max-h-[calc(100dvh-10rem)] lg:self-start lg:overflow-y-auto lg:pr-1', open && 'max-lg:hidden')}>
        {list}
      </nav>
      <div className={cn('min-w-0', !open && 'max-lg:hidden')}>{detail}</div>
    </div>
  );
}

/** Search and the one action that adds to the list. */
export function ListHeader({ query, onQuery, placeholder, children }: { query: string; onQuery: (q: string) => void; placeholder: string; children?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-1.5">
      <Input
        containerClassName="min-w-0 flex-1"
        size="sm"
        start={<Search className="size-3.5 text-t-muted" />}
        aria-label={placeholder}
        placeholder={placeholder}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
      />
      {children}
    </div>
  );
}

export function ListGroup({ title, children, testId }: { title?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <div className="mb-3 last:mb-0" data-testid={testId}>
      {title && <h3 className="px-2.5 pb-1 pt-2 text-[0.6875rem] font-medium uppercase tracking-wide text-t-muted">{title}</h3>}
      <ul className="space-y-px">{children}</ul>
    </div>
  );
}

/**
 * One entry. The whole row selects it; `trailing` holds a control of its own,
 * such as a project's on/off switch, which stays clickable above the row.
 */
export function ListRow({ testId, title, subtitle, tone, stateLabel, showState, selected, onSelect, trailing, icon }: {
  testId?: string;
  title: string;
  subtitle?: string;
  tone: Tone;
  stateLabel: string;
  /** Print the state in words; otherwise only the dot and a screen reader say it. */
  showState?: boolean;
  selected: boolean;
  onSelect: () => void;
  trailing?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <li data-testid={testId} data-selected={selected || undefined} className={cn('relative flex min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 transition-colors', selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50')}>
      <Row look="quiet" inset="none" aria-current={selected || undefined} onClick={onSelect} className="min-w-0 flex-1 focus-visible:ring-0 after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-ring">
        <span className="flex min-w-0 items-center gap-2">
          {icon ?? <StateDot tone={tone} />}
          <span className="truncate text-sm font-medium">{title}</span>
          <span className={cn('ml-auto shrink-0 text-[0.6875rem] text-t-muted', !showState && 'sr-only')}>{stateLabel}</span>
        </span>
        {subtitle && <span className="mt-0.5 block truncate pl-3.5 text-xs text-t-muted">{subtitle}</span>}
      </Row>
      {trailing && <div className="relative z-10 shrink-0">{trailing}</div>}
    </li>
  );
}

/** Where a document would be, when there is none to show. */
export function DetailEmpty({ children }: { children: ReactNode }) {
  return <Panel tone="frame" inset="none" className="flex min-h-48 items-center justify-center border-dashed p-6 text-center text-sm text-t-muted">{children}</Panel>;
}

export function ListEmpty({ children }: { children: ReactNode }) {
  return <p className="px-2.5 py-6 text-center text-sm text-t-muted">{children}</p>;
}

/** The phone's way back from a document to its list. */
export function BackToList({ onBack, label }: { onBack: () => void; label: string }) {
  return (
    <Button variant="ghost" size="sm" className="-ml-2 mb-2 lg:hidden" onClick={onBack}>
      <ArrowLeft className="size-4" />
      {label}
    </Button>
  );
}

/** A document's heading: its name, a line of facts about it, and what can be done to it. */
export function DetailHeader({ title, meta, actions }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex items-start justify-between gap-3 border-b border-border/40 pb-4">
      <div className="min-w-0">
        <h2 className="break-words text-lg font-semibold leading-tight">{title}</h2>
        {meta && <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-t-muted">{meta}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div>}
    </header>
  );
}

/** A labelled fact under a document's heading. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-xs font-medium text-t-muted">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/**
 * The body of a document. Read formatted by default, since it is Markdown
 * written for people and agents alike; the source is one switch away, exactly
 * as the agent receives it.
 */
export function Document({ children, label }: { children: string; label?: string }) {
  const [source, setSource] = useState(false);
  return (
    <Panel asChild tone="frame" inset="none" className="min-w-0"><section aria-label={label}>
      <div className="flex items-center justify-end border-b border-border/40 px-2 py-1">
        <ToggleGroup type="single" size="2xs" aria-label="Show as" value={source ? 'source' : 'formatted'} onValueChange={(v) => v && setSource(v === 'source')}>
          <ToggleGroupItem value="formatted">Formatted</ToggleGroupItem>
          <ToggleGroupItem value="source">Source</ToggleGroupItem>
        </ToggleGroup>
      </div>
      {!children.trim() ? (
        <p className="p-4 text-sm text-t-muted">Empty</p>
      ) : source ? (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-t-secondary">{children}</pre>
      ) : (
        <div className="min-w-0 p-4 text-sm [&_h1]:text-xl [&_h2]:text-lg [&_h3]:text-base">
          <MarkdownBody>{children}</MarkdownBody>
        </div>
      )}
    </section></Panel>
  );
}

/**
 * A button's words. A phone shows only the icon when the icon is obvious
 * (add, edit, save), and a screen reader still hears the name.
 */
export function Label({ children }: { children: ReactNode }) {
  return <span className="max-sm:sr-only">{children}</span>;
}

/** The phone's overflow menu: what does not earn a place on a small screen. */
export function MoreMenu({ children, className, disabled }: { children: ReactNode; className?: string; disabled?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={className} aria-label="More actions" disabled={disabled}>
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface Action { label: string; icon?: ReactNode; run: () => void; destructive?: boolean }

/**
 * A document's actions. The first is shown everywhere, as an icon on a phone;
 * the rest are buttons on a wide screen and a "More" menu on a phone.
 */
export function ActionBar({ primary, rest, disabled }: { primary?: Action; rest: Action[]; disabled?: boolean }) {
  return (
    <>
      {primary && (
        <Button variant="outline" size="sm" disabled={disabled} onClick={primary.run}>
          {primary.icon}
          <Label>{primary.label}</Label>
        </Button>
      )}
      {rest.map((a) => (
        <Button key={a.label} variant="ghost" size="sm" className={cn('max-sm:hidden', a.destructive && 'text-destructive hover:text-destructive')} disabled={disabled} onClick={a.run}>
          {a.icon}
          {a.label}
        </Button>
      ))}
      {rest.length > 0 && (
        <MoreMenu className="sm:hidden" disabled={disabled}>
          {rest.map((a) => (
            <DropdownMenuItem key={a.label} variant={a.destructive ? 'destructive' : 'default'} onSelect={a.run}>
              {a.icon}
              {a.label}
            </DropdownMenuItem>
          ))}
        </MoreMenu>
      )}
    </>
  );
}
