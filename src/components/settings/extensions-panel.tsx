/**
 * One scope's Claude plugins and the marketplaces they come from (bw-2t1c.8,
 * bw-nin9.2). Skills, agents, hooks, output styles and rules are files, and
 * live under Agent files.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

import { Loader2, Plus, Trash2 } from 'lucide-react';

import { KindIcon } from '@/components/settings/kind-icon';
import { wireScope } from '@/components/settings/mcp-servers-panel';
import { PluginCatalogue } from '@/components/settings/plugin-catalogue';
import type { Scope } from '@/components/settings/provider-settings-api';
import { SettingsGroup } from '@/components/settings/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ReadFailed } from '@/components/ui/read-failed';
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/hooks/use-toast';
import type { Brand, ExtensionItem, ExtensionKind, ExtensionKindList } from '@/workbench/protocol';
import { sendCommand } from '@/workbench/use-session';

function said(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const KIND_NAME: Record<ExtensionKind, string> = {
  plugins: 'Plugins',
  marketplaces: 'Marketplaces',
};

type Kinds = { kinds: ExtensionKindList[] };

function AddOne({
  title,
  what,
  placeholder,
  testid,
  onAdd,
}: {
  /** The sheet's heading, so the reader knows what they have opened. */
  title: string;
  /** What to type, in words: the placeholder alone was an incantation. */
  what: string;
  placeholder: string;
  testid: string;
  onAdd: (value: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await onAdd(value.trim());
      setValue('');
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid={testid}>
        <Plus /> Add
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent shape="sheet" data-testid={`${testid}-form`}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="sr-only">{what}</DialogDescription>
          </DialogHeader>
          <Input
            aria-label={placeholder}
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && value.trim()) void go();
            }}
            className="font-mono text-xs"
            autoFocus
            data-testid={`${testid}-input`}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy || !value.trim()} onClick={() => void go()} data-testid={`${testid}-submit`}>
              {busy && <Loader2 className="animate-spin" />} Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ExtensionsPanel({ brand, scope }: { brand: Brand; scope: Scope }) {
  const [kinds, setKinds] = useState<ExtensionKindList[] | null>(null);
  const [unread, setUnread] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { toast } = useToast();
  const scopeKey = JSON.stringify(scope);
  const wire = wireScope(scope);

  useEffect(() => {
    let live = true;
    setUnread(null);
    sendCommand<Kinds>({ type: 'extensions.list', brand, ...wireScope(scope) })
      .then((r) => live && setKinds(r.kinds))
      .catch((e: unknown) => live && setUnread(said(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand, scopeKey, attempt]);

  const act = useCallback(
    async (key: string, run: () => Promise<Kinds & { ok?: boolean; output?: string }>, done?: string) => {
      setBusy(key);
      try {
        const r = await run();
        setKinds(r.kinds);
        if (r.ok === false) toast({ title: 'Not done', description: r.output, variant: 'destructive' });
        else if (done) toast({ title: done });
      } catch (e) {
        toast({ title: 'Not done', description: said(e), variant: 'destructive' });
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );

  if (unread) return <ReadFailed what="Extensions unavailable" why={unread} onRetry={() => setAttempt((n) => n + 1)} />;
  if (!kinds) {
    return (
      <p className="flex items-center gap-2 p-3 text-sm text-t-tertiary">
        <Loader2 className="size-4 animate-spin" /> Reading…
      </p>
    );
  }

  const remove = (kind: ExtensionKind, item: ExtensionItem) => {
    const key = `${kind}:${item.id}`;
    if (kind === 'plugins') return act(key, () => sendCommand({ type: 'plugin.uninstall', brand, ...wire, id: item.id }), 'Uninstalled');
    return act(key, () => sendCommand({ type: 'marketplace.remove', brand, ...wire, name: item.id }), 'Removed');
  };

  return (
    <div className="space-y-4" data-testid={`extensions-${brand}`}>
      {kinds.map(({ kind, items }) => {
        const actions =
          kind === 'plugins' ? (
            <div className="flex items-center gap-2">
              <PluginCatalogue brand={brand} scope={scope} onInstalled={setKinds} />
              <AddOne
                title="Install plugin"
                what="Install a plugin named plugin@marketplace"
                placeholder="name@marketplace"
                testid="plugin-install"
                onAdd={(id) => act(`plugins:${id}`, () => sendCommand({ type: 'plugin.install', brand, ...wire, id }), 'Installed')}
              />
            </div>
          ) : (
            <AddOne
              title="Add marketplace"
              what="Add a plugin marketplace by owner/repo, git URL, or local path"
              placeholder="owner/repo, URL, or path"
              testid="marketplace-add"
              onAdd={(source) => act(`marketplaces:${source}`, () => sendCommand({ type: 'marketplace.add', brand, ...wire, source }), 'Added')}
            />
          );
        return (
          <SettingsGroup key={kind} title={KIND_NAME[kind]} actions={actions} data-testid={`extensions-${kind}`}>
            {items.length === 0 && <p className="p-3 text-sm text-t-tertiary">None</p>}
            {items.map((item) => {
              const key = `${kind}:${item.id}`;
              const detail = item.description ?? '';
              return (
                <div key={key} className="flex items-center gap-3 px-3 py-2" data-testid={`extension-${kind}-${item.id}`}>
                  {kind === 'plugins' && (
                    <Checkbox
                      aria-label={`${item.name} on`}
                      checked={item.enabled !== false}
                      disabled={busy !== null}
                      onCheckedChange={(c) => void act(key, () => sendCommand({ type: 'plugin.set-enabled', brand, ...wire, id: item.id, enabled: c === true }))}
                      data-testid={`plugin-enabled-${item.id}`}
                    />
                  )}
                  <KindIcon kind={kind === 'plugins' ? 'plugin' : 'marketplace'} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-t-primary">{item.name}</span>
                      {item.version && (
                        <Badge variant="outline" size="sm">
                          {item.version}
                        </Badge>
                      )}
                      {item.marketplace && (
                        <Badge variant="secondary" size="sm">
                          {item.marketplace}
                        </Badge>
                      )}
                      {item.source && scope.kind === 'project' && (
                        <Badge variant="secondary" size="sm">
                          {item.source === 'user' ? 'Account' : 'Project'}
                        </Badge>
                      )}
                      {busy === key && <Loader2 className="size-3 animate-spin text-t-muted" />}
                    </div>
                    {detail && (
                      <Tooltip label={detail}>
                        <p className="truncate text-xs text-t-muted">{detail}</p>
                      </Tooltip>
                    )}
                  </div>
                  <Button variant="ghost" size="sm" aria-label={`Remove ${item.name}`} disabled={busy !== null} onClick={() => void remove(kind, item)} data-testid={`extension-remove-${item.id}`}>
                    <Trash2 />
                  </Button>
                </div>
              );
            })}
          </SettingsGroup>
        );
      })}
    </div>
  );
}
