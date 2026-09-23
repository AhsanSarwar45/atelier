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

import { useCallback, useEffect, useMemo, useState } from 'react';

import { Loader2, Search, Store } from 'lucide-react';

import { KindIcon } from '@/components/settings/kind-icon';
import type { Scope } from '@/components/settings/provider-settings-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ReadFailed } from '@/components/ui/read-failed';
import { Tooltip } from '@/components/ui/tooltip';
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
function matches(entry: OfferedPlugin, want: string): boolean {
  if (!want) return true;
  const hay = [entry.name, entry.title, entry.description ?? '', entry.marketplace, ...(entry.keywords ?? [])].join(' ').toLowerCase();
  return hay.includes(want);
}

// Codex's store alone lists thousands; a row off screen is not laid out or
// painted until it is scrolled to, so the sheet opens as fast with all of them.
function Row({ entry, busy, onInstall }: { entry: OfferedPlugin; busy: boolean; onInstall: (entry: OfferedPlugin) => Promise<void> }) {
  return (
    <li className="flex items-start gap-3 px-3 py-2 [contain-intrinsic-size:auto_4rem] [content-visibility:auto]" data-testid={`plugin-entry-${entry.id}`}>
      <KindIcon kind="plugin" />
      <div className="min-w-0 flex-1">
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
      </div>
      <Button
        size="sm"
        variant={entry.installed ? 'ghost' : 'outline'}
        disabled={busy || entry.installed}
        onClick={() => void onInstall(entry)}
        data-testid={`plugin-catalogue-install-${entry.id}`}
      >
        {busy && <Loader2 className="animate-spin" />} {entry.installed ? 'Installed' : 'Install'}
      </Button>
    </li>
  );
}

export function PluginCatalogue({ brand, scope, onInstalled }: { brand: Brand; scope: Scope; onInstalled: (kinds: ExtensionKindList[]) => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [shelf, setShelf] = useState<string | null>(null);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [unread, setUnread] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { toast } = useToast();
  const scopeKey = JSON.stringify(scope);

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

  const want = typed.trim().toLowerCase();
  const shown = useMemo(() => {
    const entries = catalogue?.entries ?? [];
    // A shelf ticked before a search must not narrow what the search finds.
    return entries.filter((e) => matches(e, want) && (!shelf || want !== '' || e.category === shelf));
  }, [catalogue, shelf, want]);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="plugin-browse">
        <Store /> Browse
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent shape="sheet" className="sm:max-w-2xl" data-testid="plugin-catalogue">
          <DialogHeader>
            <DialogTitle>Install plugin</DialogTitle>
            <DialogDescription className="sr-only">Install a plugin from a marketplace</DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-t-muted" />
            <Input
              aria-label="Search plugins"
              placeholder="Search plugins…"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="pl-8"
              data-testid="plugin-catalogue-search"
            />
          </div>
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
              <Loader2 className="size-4 animate-spin" /> Reading…
            </p>
          ) : shown.length === 0 ? (
            <p className="p-3 text-sm text-t-tertiary" data-testid="plugin-catalogue-none">
              No matches
            </p>
          ) : (
            <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto rounded-md border border-border" data-testid="plugin-catalogue-list">
              {shown.map((entry) => (
                <Row key={entry.id} entry={entry} busy={busy === entry.id} onInstall={install} />
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
