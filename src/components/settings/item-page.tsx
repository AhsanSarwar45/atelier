/**
 * The page a plugin or an MCP server opens to (bw-moh1k).
 *
 * A row in a list can say a name and one line; this is where the rest goes:
 * what it is, who makes it, where its source lives, what it adds, and its
 * README. Plugins and servers, Claude and Codex, all open the same page, so
 * the two providers look and work alike.
 */
'use client';

import { useState, type ReactNode } from 'react';

import { ArrowLeft, ExternalLink } from 'lucide-react';

import { MarkdownBody } from '@/components/markdown-body';
import { KindIcon, type IconKind } from '@/components/settings/kind-icon';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

/** One line of the Details list. */
export interface Fact {
  label: string;
  value: ReactNode;
}

/** One group under Includes: a plugin's commands, its skills, its servers. */
export interface PartGroup {
  label: string;
  parts: { name: string; description?: string; onOpen?: () => void }[];
}

/** An address, shown without its scheme, that opens in a new tab. */
export function Link({ href, children }: { href: string; children?: ReactNode }) {
  const shown = href.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1 text-info underline-offset-4 hover:underline">
      <span className="truncate">{children ?? shown}</span>
      <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
    </a>
  );
}

/** A group of names, the first few shown and the rest behind Show all. */
function Parts({ group, testId }: { group: PartGroup; testId: string }) {
  const [all, setAll] = useState(false);
  const LIMIT = 8;
  const shown = all ? group.parts : group.parts.slice(0, LIMIT);
  return (
    <div className="space-y-1.5" data-testid={testId}>
      <h4 className="text-xs font-medium text-t-tertiary">
        {group.label} <span className="text-t-muted">{group.parts.length}</span>
      </h4>
      <ul className="space-y-1">
        {shown.map((part) => (
          <li key={part.name} className="min-w-0 text-sm">
            {part.onOpen ? (
              <Button mode="link" size="inherit" className="font-mono text-xs text-info underline-offset-4 hover:underline" onClick={part.onOpen}>
                {part.name}
              </Button>
            ) : (
              <span className="font-mono text-xs text-t-primary">{part.name}</span>
            )}
            {part.description && <p className="line-clamp-2 text-xs text-t-muted">{part.description}</p>}
          </li>
        ))}
      </ul>
      {group.parts.length > LIMIT && (
        <Button variant="ghost" size="sm" className="h-6 px-1 text-xs" onClick={() => setAll((a) => !a)}>
          {all ? 'Show fewer' : `Show all ${group.parts.length}`}
        </Button>
      )}
    </div>
  );
}

/**
 * Which item's page is open: the address's, when the screen keeps it there,
 * or this panel's own otherwise.
 */
export function useOpenItem(item?: string | null, onItem?: (item: string | null) => void): [string | null, (item: string | null) => void] {
  const [own, setOwn] = useState<string | null>(null);
  return onItem ? [item ?? null, onItem] : [own, setOwn];
}

export function ItemPage({
  kind,
  icon,
  title,
  byline,
  badges,
  actions,
  description,
  longDescription,
  readme,
  readmeBase,
  readmeLoading,
  facts,
  groups,
  backLabel,
  onBack,
  wide = true,
  testId,
  children,
}: {
  kind: IconKind;
  icon?: string;
  title: string;
  /** Who makes it, or where it comes from. */
  byline?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  description?: string;
  longDescription?: string;
  readme?: string;
  /** The folder the README was read out of, so its relative links and images resolve. */
  readmeBase?: string;
  readmeLoading?: boolean;
  facts: Fact[];
  groups?: PartGroup[];
  /** What Back returns to, such as "Plugins". */
  backLabel: string;
  onBack: () => void;
  /** Room for a side column. False inside a sheet. */
  wide?: boolean;
  testId: string;
  /** Anything else the page needs, drawn under the description. */
  children?: ReactNode;
}) {
  const shownFacts = facts.filter((f) => f.value !== undefined && f.value !== null && f.value !== '');
  const shownGroups = (groups ?? []).filter((g) => g.parts.length > 0);
  const side = (
    <aside className="space-y-5" data-testid={`${testId}-details`}>
      {shownFacts.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-t-primary">Details</h3>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
            {shownFacts.map((f) => (
              <div key={f.label} className="contents">
                <dt className="text-t-tertiary">{f.label}</dt>
                <dd className="min-w-0 break-words text-t-primary">{f.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {shownGroups.length > 0 && (
        <section className="space-y-3" data-testid={`${testId}-includes`}>
          <h3 className="text-sm font-semibold text-t-primary">Includes</h3>
          {shownGroups.map((g) => (
            <Parts key={g.label} group={g} testId={`${testId}-includes-${g.label.toLowerCase().replace(/\s+/g, '-')}`} />
          ))}
        </section>
      )}
    </aside>
  );

  return (
    <div className="space-y-5" data-testid={testId}>
      <Button variant="ghost" size="sm" className="-ml-2" onClick={onBack} data-testid="item-back">
        <ArrowLeft /> {backLabel}
      </Button>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <KindIcon kind={kind} src={icon} className="size-14 [&>svg]:size-7" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <h2 className="break-words text-xl font-semibold text-t-primary" data-testid={`${testId}-title`}>
            {title}
          </h2>
          {byline && <p className="text-sm text-t-tertiary">{byline}</p>}
          {badges && <div className="flex flex-wrap items-center gap-1.5">{badges}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div className={cn('grid gap-6', wide && 'lg:grid-cols-[minmax(0,1fr)_18rem]')}>
        <div className="min-w-0 space-y-4">
          {description && (
            <p className="text-sm text-t-secondary" data-testid={`${testId}-description`}>
              {description}
            </p>
          )}
          {longDescription && longDescription !== description && <p className="whitespace-pre-line text-sm text-t-secondary">{longDescription}</p>}
          {children}
          {!wide && side}
          {readmeLoading ? (
            <p className="flex items-center gap-2 text-sm text-t-tertiary">
              <Spinner /> Reading README…
            </p>
          ) : readme ? (
            <Panel inset="none" className="min-w-0 overflow-hidden p-5" data-testid={`${testId}-readme`}>
              <MarkdownBody base={readmeBase}>{readme}</MarkdownBody>
            </Panel>
          ) : null}
        </div>
        {wide && side}
      </div>
    </div>
  );
}
