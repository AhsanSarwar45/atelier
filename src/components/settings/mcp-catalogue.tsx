/**
 * The catalogue an MCP server is found in and added from (bw-6ecp.6).
 *
 * Adding one used to mean knowing the package name and the flags it wants,
 * which is fine for somebody who has read the server's README and no use to
 * somebody who only knows they want Notion. This is the other way in: shelves
 * to browse, a box to search, and Add on every row.
 *
 * Browsing shows the curated set the server bundles — categorised, with an icon
 * and a line about each. Typing searches the official registry live, which is
 * far larger and has neither, and what comes back wears the curated set's icon
 * and shelf wherever the two name the same repository.
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { Boxes, Plus, Search } from 'lucide-react';

import { KindIcon } from '@/components/settings/kind-icon';
import type { Scope } from '@/components/settings/provider-settings-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Panel } from '@/components/ui/panel';
import { ReadFailed } from '@/components/ui/read-failed';
import { Tooltip } from '@/components/ui/tooltip';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/hooks/use-toast';
import type { Brand, McpCatalogue as Catalogue, McpCatalogueEntry, McpServer, McpSource, SettingsScope } from '@/workbench/protocol';
import { sendCommand } from '@/workbench/use-session';

/** The same wiring the panel does; spelled here so the two do not import each other. */
function wireScope(scope: Scope): SettingsScope {
  return scope.kind === 'account' ? { scope: 'account', profileId: scope.profileId } : { scope: 'project', projectPath: scope.projectPath };
}

function said(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `devops` is a directory name; the reader is shown a shelf. */
export function shelfName(id: string): string {
  const words: Record<string, string> = {
    ai: 'AI',
    devops: 'DevOps',
    iot: 'IoT',
  };
  return words[id] ?? id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, ' ');
}

/** One row, and the boxes it asks for before it can be added. */
function Row({
  entry,
  busy,
  onAdd,
}: {
  entry: McpCatalogueEntry;
  busy: boolean;
  onAdd: (entry: McpCatalogueEntry, env: Record<string, string>) => Promise<void>;
}) {
  const needs = entry.needs ?? [];
  const [asking, setAsking] = useState(false);
  const [given, setGiven] = useState<Record<string, string>>({});
  const missing = needs.some((need) => !(given[need.name] ?? '').trim());

  return (
    <li className="flex flex-col gap-2 px-3 py-2" data-testid={`catalogue-entry-${entry.id}`}>
      <div className="flex items-start gap-3">
        <KindIcon kind="server" src={entry.icon} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-t-primary">{entry.title}</span>
            {entry.category && (
              <Badge variant="secondary" size="sm">
                {shelfName(entry.category)}
              </Badge>
            )}
            {entry.container && (
              <Tooltip label="Runs in Docker">
                <Badge variant="outline" size="sm">
                  Needs Docker
                </Badge>
              </Tooltip>
            )}
            {entry.transport === 'http' && (
              <Badge variant="outline" size="sm">
                Remote
              </Badge>
            )}
          </div>
          {entry.description && <p className="line-clamp-1 text-xs text-t-muted">{entry.description}</p>}
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => (needs.length > 0 && !asking ? setAsking(true) : void onAdd(entry, given))}
          data-testid={`catalogue-add-${entry.id}`}
        >
          {busy ? <Spinner size="inherit" /> : <Plus />} Add
        </Button>
      </div>
      {asking && needs.length > 0 && (
        <div className="space-y-2 pl-11" data-testid={`catalogue-needs-${entry.id}`}>
          <p className="text-xs font-medium text-t-secondary">Required</p>
          {needs.map((need) => (
            <div key={need.name} className="space-y-1">
              <Input
                aria-label={need.name}
                placeholder={need.name}
                value={given[need.name] ?? ''}
                onChange={(e) => setGiven((was) => ({ ...was, [need.name]: e.target.value }))}
                className="font-mono text-xs"
                data-testid={`catalogue-need-${entry.id}-${need.name}`}
              />
              {need.description && <p className="text-xs text-t-muted">{need.description}</p>}
            </div>
          ))}
          <Button size="sm" disabled={busy || missing} onClick={() => void onAdd(entry, given)} data-testid={`catalogue-confirm-${entry.id}`}>
            {busy && <Spinner size="inherit" />} Add
          </Button>
        </div>
      )}
    </li>
  );
}

export function McpCatalogue({ brand, scope, source, onAdded }: { brand: Brand; scope: Scope; source: McpSource; onAdded: (servers: McpServer[]) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [typed, setTyped] = useState('');
  const [shelf, setShelf] = useState<string | null>(null);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [unread, setUnread] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { toast } = useToast();

  // A keystroke is not a search: the registry is asked once the typing stops.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(typed), 300);
    return () => clearTimeout(timer);
  }, [typed]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setUnread(null);
    setCatalogue(null);
    sendCommand<Catalogue>({ type: 'mcp.catalogue', ...(search.trim() ? { search: search.trim() } : {}) })
      .then((r) => live && setCatalogue(r))
      .catch((e: unknown) => live && setUnread(said(e)));
    return () => {
      live = false;
    };
  }, [open, search]);

  const add = useCallback(
    async (entry: McpCatalogueEntry, env: Record<string, string>) => {
      setBusy(entry.id);
      try {
        const { servers } = await sendCommand<{ servers: McpServer[] }>({
          type: 'mcp.add-from-catalogue',
          brand,
          ...wireScope(scope),
          source,
          entry,
          env,
        });
        onAdded(servers);
        toast({ title: `${entry.title} added` });
        setOpen(false);
      } catch (e) {
        toast({ title: 'Not added', description: said(e), variant: 'destructive' });
      } finally {
        setBusy(null);
      }
    },
    [brand, scope, source, onAdded, toast],
  );

  // A search is across everything. The shelves are put away while one is typed,
  // and a shelf left ticked from before must not quietly narrow what it found.
  const searching = search.trim().length > 0;
  const shown = useMemo(() => {
    const entries = catalogue?.entries ?? [];
    return shelf && !searching ? entries.filter((e) => e.category === shelf) : entries;
  }, [catalogue, shelf, searching]);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="mcp-browse">
        <Boxes /> Browse
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent shape="sheet" className="sm:max-w-2xl" data-testid="mcp-catalogue">
          <DialogHeader>
            <DialogTitle>Add server</DialogTitle>
            <DialogDescription className="sr-only">Add an MCP server from the catalogue</DialogDescription>
          </DialogHeader>
          <Input
            start={<Search className="text-t-muted" aria-hidden="true" />}
            aria-label="Search servers"
            placeholder="Search servers…"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            data-testid="mcp-catalogue-search"
          />
          {catalogue && !searching && (
            <div className="flex flex-wrap gap-1.5" data-testid="mcp-catalogue-shelves">
              <Button size="sm" variant={shelf === null ? 'secondary' : 'ghost'} onClick={() => setShelf(null)} data-testid="catalogue-shelf-all">
                All {catalogue.entries.length}
              </Button>
              {catalogue.categories.map((c) => (
                <Button key={c.id} size="sm" variant={shelf === c.id ? 'secondary' : 'ghost'} onClick={() => setShelf(c.id)} data-testid={`catalogue-shelf-${c.id}`}>
                  {shelfName(c.id)} {c.count}
                </Button>
              ))}
            </div>
          )}
          {catalogue?.source === 'curated-only' && (
            <Tooltip label={catalogue.unreachable ?? 'The registry could not be reached'}>
              <p className="text-xs text-t-muted" role="status" data-testid="mcp-catalogue-offline">
                Registry offline — bundled list only
              </p>
            </Tooltip>
          )}
          {unread ? (
            <ReadFailed what="Catalogue unavailable" why={unread} onRetry={() => setSearch((s) => `${s}`)} />
          ) : !catalogue ? (
            <p className="flex items-center gap-2 p-3 text-sm text-t-tertiary">
              <Spinner /> Reading…
            </p>
          ) : shown.length === 0 ? (
            <p className="p-3 text-sm text-t-tertiary" data-testid="mcp-catalogue-none">
              No matches
            </p>
          ) : (
            <Panel asChild tone="frame" inset="none" className="max-h-[50vh] divide-y divide-border overflow-y-auto">
              <ul data-testid="mcp-catalogue-list">
                {shown.map((entry) => (
                  <Row key={`${entry.registryName ?? ''}:${entry.id}`} entry={entry} busy={busy === entry.id} onAdd={add} />
                ))}
              </ul>
            </Panel>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
