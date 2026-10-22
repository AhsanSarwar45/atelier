/**
 * The catalogue a plugin is found in and installed from (bw-6ecp.7).
 *
 * Installing one meant knowing both halves of `plugin@marketplace` and having
 * added the marketplace first, which is a thing you can only do if you already
 * know what is in it. This is the other way in: the marketplaces the account
 * has and the ones Anthropic publishes, read for what they offer, shelved by
 * the category each entry declares, with Install on every row. Installing from
 * a marketplace the account has never added adds it first.
 */
'use client';

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';

import { Search, Store } from 'lucide-react';

import { CatalogueList } from '@/components/settings/catalogue-list';
import { KindIcon } from '@/components/settings/kind-icon';
import { PluginPage } from '@/components/settings/plugin-page';
import type { Scope } from '@/components/settings/provider-settings-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ReadFailed } from '@/components/ui/read-failed';
import { Tooltip } from '@/components/ui/tooltip';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/hooks/use-toast';
import type { Brand, ExtensionKindList, OfferedPlugin, PluginCatalogue as Catalogue, SettingsScope } from '@/workbench/protocol';
import { sendCommand } from '@/workbench/use-session';

/** The same wiring the panels do; spelled here so the two do not import each other. */
function wireScope(scope: Scope): SettingsScope {
  return scope.kind === 'account' ? { scope: 'account', profileId: scope.profileId } : { scope: 'project', projectPath: scope.projectPath };
}

function said(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `code-review` is a directory name; the reader is shown a shelf. */
export function shelfName(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, ' ');
}

/** Everything the row is searched by, not only its name. */
function haystack(entry: OfferedPlugin): string {
  return [entry.name, entry.title, entry.description ?? '', entry.marketplace, ...(entry.keywords ?? [])].join(' ').toLowerCase();
}

const Row = memo(function Row({
  entry,
  busy,
  onInstall,
  onOpen,
}: {
  entry: OfferedPlugin;
  busy: boolean;
  onInstall: (entry: OfferedPlugin) => Promise<void>;
  onOpen: (entry: OfferedPlugin) => void;
}) {
  return (
    <div className="flex items-start gap-3 px-3 py-2 transition-colors hover:bg-surface-overlay/40" data-testid={`plugin-entry-${entry.id}`}>
      <KindIcon kind="plugin" />
      <Button
        variant="ghost"
        size="none"
        className="block h-auto min-w-0 flex-1 whitespace-normal text-left font-normal hover:bg-transparent"
        aria-label={`Open ${entry.title}`}
        onClick={() => onOpen(entry)}
        data-testid={`plugin-catalogue-open-${entry.id}`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-t-primary">{entry.title}</span>
          {entry.category && (
            <Badge variant="secondary" size="sm">
              {shelfName(entry.category)}
            </Badge>
          )}
          <Tooltip label={entry.known ? 'Marketplace added' : 'Marketplace added on install'}>
            <Badge variant="outline" size="sm">
              <Store /> {entry.marketplace}
            </Badge>
          </Tooltip>
          {entry.version && (
            <Badge variant="outline" size="sm">
              {entry.version}
            </Badge>
          )}
        </div>
        {entry.description && <p className="line-clamp-1 text-xs text-t-muted">{entry.description}</p>}
      </Button>
      <Button
        size="sm"
        variant={entry.installed ? 'ghost' : 'outline'}
        disabled={busy || entry.installed}
        onClick={() => void onInstall(entry)}
        data-testid={`plugin-catalogue-install-${entry.id}`}
      >
        {busy && <Spinner size="inherit" />} {entry.installed ? 'Installed' : 'Install'}
      </Button>
    </div>
  );
});

export function PluginCatalogue({ brand, scope, onInstalled }: { brand: Brand; scope: Scope; onInstalled: (kinds: ExtensionKindList[]) => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [shelf, setShelf] = useState<string | null>(null);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [unread, setUnread] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** The entry whose page is drawn in place of the list. */
  const [viewing, setViewing] = useState<OfferedPlugin | null>(null);
  const { toast } = useToast();
  const scopeKey = JSON.stringify(scope);

  useEffect(() => {
    if (!open) setViewing(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setUnread(null);
    setCatalogue(null);
    sendCommand<Catalogue>({ type: 'plugin.catalogue', brand, ...wireScope(scope) })
      .then((r) => live && setCatalogue(r))
      .catch((e: unknown) => live && setUnread(said(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, brand, scopeKey, attempt]);

  const install = useCallback(
    async (entry: OfferedPlugin) => {
      setBusy(entry.id);
      try {
        const answer = await sendCommand<{ kinds: ExtensionKindList[]; ok?: boolean; output?: string }>({
          type: 'plugin.install-from-catalogue',
          brand,
          ...wireScope(scope),
          id: entry.id,
          origin: entry.origin,
          known: entry.known,
        });
        onInstalled(answer.kinds);
        if (answer.ok === false) {
          toast({ title: 'Not installed', description: answer.output, variant: 'destructive' });
          return;
        }
        toast({ title: `${entry.title} installed` });
        setOpen(false);
      } catch (e) {
        toast({ title: 'Not installed', description: said(e), variant: 'destructive' });
      } finally {
        setBusy(null);
      }
    },
    [brand, scope, onInstalled, toast],
  );

  // Each entry's search text is built once per catalogue, not once per keystroke.
  const indexed = useMemo(() => (catalogue?.entries ?? []).map((entry) => ({ entry, hay: haystack(entry) })), [catalogue]);
  // The box takes every keystroke at once; the list catches up when React has time.
  const want = useDeferredValue(typed.trim().toLowerCase());
  const shown = useMemo(
    () =>
      indexed
        // A shelf ticked before a search must not narrow what the search finds.
        .filter(({ entry, hay }) => (want ? hay.includes(want) : !shelf || entry.category === shelf))
        .map(({ entry }) => entry),
    [indexed, shelf, want],
  );

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="plugin-browse">
        <Store /> Browse
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent shape="sheet" className="sm:max-w-2xl" data-testid="plugin-catalogue">
          <DialogHeader className={viewing ? 'sr-only' : undefined}>
            <DialogTitle>Install plugin</DialogTitle>
            <DialogDescription className="sr-only">Install a plugin from a marketplace</DialogDescription>
          </DialogHeader>
          {viewing && (
            <PluginPage
              brand={brand}
              scope={scope}
              summary={viewing}
              backLabel="All plugins"
              onBack={() => setViewing(null)}
              wide={false}
              actions={
                <Button
                  size="sm"
                  variant={viewing.installed ? 'ghost' : 'primary'}
                  disabled={busy !== null || viewing.installed}
                  onClick={() => void install(viewing)}
                  data-testid={`plugin-page-install-${viewing.id}`}
                >
                  {busy === viewing.id && <Spinner size="inherit" />} {viewing.installed ? 'Installed' : 'Install'}
                </Button>
              }
            />
          )}
          <div className={viewing ? 'hidden' : 'contents'}>
          <Input
            start={<Search className="text-t-muted" aria-hidden="true" />}
            aria-label="Search plugins"
            placeholder="Search plugins…"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            data-testid="plugin-catalogue-search"
          />
          {catalogue && want === '' && catalogue.categories.length > 0 && (
            <div className="flex flex-wrap gap-1.5" data-testid="plugin-catalogue-shelves">
              <Button size="sm" variant={shelf === null ? 'secondary' : 'ghost'} onClick={() => setShelf(null)} data-testid="plugin-shelf-all">
                All {catalogue.entries.length}
              </Button>
              {catalogue.categories.map((c) => (
                <Button key={c.id} size="sm" variant={shelf === c.id ? 'secondary' : 'ghost'} onClick={() => setShelf(c.id)} data-testid={`plugin-shelf-${c.id}`}>
                  {shelfName(c.id)} {c.count}
                </Button>
              ))}
            </div>
          )}
          {catalogue?.unreachable && catalogue.unreachable.length > 0 && (
            <Tooltip label={catalogue.unreachable.join('; ')}>
              <p className="text-xs text-t-muted" role="status" data-testid="plugin-catalogue-unreachable">
                Some marketplaces unreachable
              </p>
            </Tooltip>
          )}
          {unread ? (
            <ReadFailed what="Plugins unavailable" why={unread} onRetry={() => setAttempt((n) => n + 1)} />
          ) : !catalogue ? (
            <p className="flex items-center gap-2 p-3 text-sm text-t-tertiary">
              <Spinner /> Reading…
            </p>
          ) : shown.length === 0 ? (
            <p className="p-3 text-sm text-t-tertiary" data-testid="plugin-catalogue-none">
              No matches
            </p>
          ) : (
            <CatalogueList
              items={shown}
              itemKey={(entry) => entry.id}
              render={(entry) => <Row entry={entry} busy={busy === entry.id} onInstall={install} onOpen={setViewing} />}
              testId="plugin-catalogue-list"
            />
          )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
