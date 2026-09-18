/**
 * Copies chosen parts of one account into other accounts of the same provider
 * (bw-2t1c.11, bw-6ecp.5).
 *
 * It used to copy exactly one page — whichever was open — and there was no way
 * to say so: no list of what would move, and nothing at all for the two things
 * a reader most wants on a second account, its MCP servers and its plugins.
 * Now both sides are chosen: which sections, and which accounts.
 *
 * The two kinds of section behave differently, and the sheet says which is
 * which. A settings page is copied key for key, so a key the source does not
 * set is cleared in the target — that is what makes the target match. Servers
 * and plugins are added, never removed: an account's own extras survive.
 */
'use client';

import { useMemo, useState } from 'react';

import { Copy, Loader2 } from 'lucide-react';

import { pagesFor, type Brand } from '@/components/settings/provider-schema';
import { getPath, readSettings, writeSettings } from '@/components/settings/provider-settings-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import type { ExtensionItem, ExtensionKind, McpServer, ProfileChoice } from '@/workbench/protocol';
import { sendCommand } from '@/workbench/use-session';

function said(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** One tickable part of an account. */
interface SectionDef {
  id: string;
  label: string;
  /** What ticking it does to the target, in the target's own terms. */
  hint: string;
}

/** Everything of an account that can be copied, in the order the tabs have them. */
export function copyableSections(brand: Brand): SectionDef[] {
  return [
    ...pagesFor(brand).map((p) => ({ id: p.id, label: p.label, hint: 'Every setting on the page, so one the source leaves unset is cleared there' })),
    { id: 'mcp', label: 'MCP servers', hint: 'Added to the account; servers it already has are kept' },
    // Codex has no plugin system.
    ...(brand === 'claude' ? [{ id: 'plugins', label: 'Plugins', hint: 'Marketplaces added, then the same plugins installed; nothing is removed' }] : []),
  ];
}

export function CopyToAccounts({ brand, from, profiles, page }: { brand: Brand; from: string; profiles: ProfileChoice[]; page: string }) {
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<Set<string>>(new Set());
  const sections = useMemo(() => copyableSections(brand), [brand]);
  // The section being looked at is the one most likely meant, so it starts ticked.
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(sections.some((s) => s.id === page) ? [page] : []));
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const others = profiles.filter((p) => p.id !== from);
  if (others.length === 0) return null;

  const toggle = (set: (f: (was: Set<string>) => Set<string>) => void, id: string, on: boolean) =>
    set((was) => {
      const next = new Set(was);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /** The settings pages, as one patch per target so each account is written once. */
  const copyPages = async (targets: string[]) => {
    const pages = pagesFor(brand).filter((p) => ticked.has(p.id));
    if (pages.length === 0) return;
    const view = await readSettings(brand, { kind: 'account', profileId: from });
    const mine = view.files.find((f) => f.layer === 'user')?.value ?? {};
    const patch: Record<string, unknown> = {};
    for (const pageDef of pages) {
      for (const group of pageDef.groups) {
        for (const def of group.settings) {
          const value = getPath(mine, def.key);
          patch[def.key] = value === undefined ? null : value;
        }
      }
    }
    for (const id of targets) await writeSettings(brand, { kind: 'account', profileId: id }, 'user', patch);
  };

  /** This account's own servers, put on each target under the same names. */
  const copyServers = async (targets: string[]) => {
    if (!ticked.has('mcp')) return;
    const { servers } = await sendCommand<{ servers: McpServer[] }>({ type: 'mcp.list', brand, scope: 'account', profileId: from });
    const mine = servers.filter((s) => s.source === 'user');
    for (const id of targets) {
      for (const server of mine) {
        await sendCommand({ type: 'mcp.add', brand, scope: 'account', profileId: id, source: 'user', id: server.id, config: server.config });
      }
    }
  };

  /** The marketplaces first — a plugin cannot be installed before the one it comes from. */
  const copyPlugins = async (targets: string[]) => {
    if (!ticked.has('plugins')) return;
    const { kinds } = await sendCommand<{ kinds: { kind: ExtensionKind; items: ExtensionItem[] }[] }>({
      type: 'extensions.list',
      brand,
      scope: 'account',
      profileId: from,
    });
    const of = (kind: ExtensionKind) => kinds.find((k) => k.kind === kind)?.items ?? [];
    for (const id of targets) {
      for (const place of of('marketplaces')) {
        // A marketplace whose file does not say where it came from cannot be
        // added anywhere else; its plugins are skipped with it.
        if (place.origin) await sendCommand({ type: 'marketplace.add', brand, scope: 'account', profileId: id, source: place.origin });
      }
      for (const plugin of of('plugins')) {
        await sendCommand({ type: 'plugin.install', brand, scope: 'account', profileId: id, id: plugin.id });
      }
    }
  };

  const copy = async () => {
    setBusy(true);
    try {
      const targets = [...accounts];
      await copyPages(targets);
      await copyServers(targets);
      await copyPlugins(targets);
      const what = sections.filter((s) => ticked.has(s.id)).length;
      toast({ title: `Copied ${what} ${what === 1 ? 'section' : 'sections'} to ${targets.length} ${targets.length === 1 ? 'account' : 'accounts'}` });
      setOpen(false);
      setAccounts(new Set());
    } catch (e) {
      toast({ title: 'Not copied', description: said(e), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => setOpen(true)} data-testid={`copy-to-accounts-${brand}`}>
        <Copy /> Copy to…
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="copy-to-accounts-dialog">
          <DialogHeader>
            <DialogTitle>Copy this account to another</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-4 overflow-y-auto">
            <section className="space-y-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-t-tertiary">What to copy</h3>
              <ul className="divide-y divide-border rounded-md border border-border" data-testid="copy-to-sections">
                {sections.map((s) => (
                  <li key={s.id} className="flex items-start gap-3 px-3 py-2">
                    <Checkbox
                      id={`copy-section-${s.id}`}
                      className="mt-0.5"
                      checked={ticked.has(s.id)}
                      onCheckedChange={(c) => toggle(setTicked, s.id, c === true)}
                      data-testid={`copy-section-${s.id}`}
                    />
                    <label htmlFor={`copy-section-${s.id}`} className="flex-1 cursor-pointer">
                      <span className="flex items-center gap-2 text-sm text-t-primary">
                        {s.label}
                        {s.id === 'mcp' || s.id === 'plugins' ? (
                          <Badge variant="secondary" size="sm">
                            Added, never removed
                          </Badge>
                        ) : null}
                      </span>
                      <span className="block text-xs text-t-muted">{s.hint}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
            <section className="space-y-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-t-tertiary">Where to copy it</h3>
              <ul className="divide-y divide-border rounded-md border border-border">
                {others.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                    <Checkbox
                      id={`copy-to-${p.id}`}
                      checked={accounts.has(p.id)}
                      onCheckedChange={(c) => toggle(setAccounts, p.id, c === true)}
                      data-testid={`copy-to-${p.id}`}
                    />
                    <label htmlFor={`copy-to-${p.id}`} className="flex-1 cursor-pointer text-sm text-t-primary">
                      {p.name}
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy || accounts.size === 0 || ticked.size === 0} onClick={() => void copy()} data-testid="copy-to-accounts-confirm">
              {busy && <Loader2 className="animate-spin" />} Copy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
