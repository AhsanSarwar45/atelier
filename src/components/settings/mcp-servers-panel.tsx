/**
 * One scope's MCP servers: the list, a switch on each, sign in, remove, and a
 * form to add one — as a command or a URL, or pasted as JSON (bw-2t1c.6).
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

import { Loader2, LogIn, LogOut, Plus, Trash2 } from 'lucide-react';

import type { Scope } from '@/components/settings/provider-settings-api';
import { SettingsGroup } from '@/components/settings/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Panel } from '@/components/ui/panel';
import { ReadFailed } from '@/components/ui/read-failed';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/hooks/use-toast';
import type { Brand, McpElsewhere, McpServer, McpSource, SettingsScope } from '@/workbench/protocol';
import { sendCommand } from '@/workbench/use-session';

function said(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function wireScope(scope: Scope): SettingsScope {
  return scope.kind === 'account' ? { scope: 'account', profileId: scope.profileId } : { scope: 'project', projectPath: scope.projectPath };
}

const SOURCE_NAME: Record<McpSource, string> = { user: 'Account', project: 'Project', local: 'Project, this computer' };

/** What `mcp.list` answers with: this account's servers, and the other accounts'. */
type Listed = { servers: McpServer[]; elsewhere?: McpElsewhere[] };

/** Where a new server goes, given the scope and the brand. */
function sourcesFor(brand: Brand, scope: Scope): McpSource[] {
  if (scope.kind === 'account') return ['user'];
  return brand === 'claude' ? ['project', 'local'] : ['project'];
}

function AddServer({ brand, scope, onAdded }: { brand: Brand; scope: Scope; onAdded: (servers: McpServer[]) => void }) {
  const sources = sourcesFor(brand, scope);
  const [open, setOpen] = useState(false);
  const [id, setId] = useState('');
  const [how, setHow] = useState<'command' | 'url' | 'json'>('command');
  const [source, setSource] = useState<McpSource>(sources[0]);
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [env, setEnv] = useState('');
  const [json, setJson] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  const submit = async () => {
    setRefused(null);
    let config: Record<string, unknown>;
    try {
      if (how === 'json') {
        const parsed = JSON.parse(json) as Record<string, unknown>;
        // `{ "mcpServers": { "name": {...} } }` pasted whole names the server itself.
        const inner = parsed.mcpServers as Record<string, Record<string, unknown>> | undefined;
        if (inner && Object.keys(inner).length === 1) {
          const [name, cfg] = Object.entries(inner)[0];
          config = cfg;
          if (!id) setId(name);
          return add(name, config);
        }
        config = parsed;
      } else if (how === 'url') {
        config = brand === 'claude' ? { type: 'http', url } : { url };
      } else {
        const [cmd, ...args] = command.trim().split(/\s+/);
        config = brand === 'claude' ? { type: 'stdio', command: cmd, args } : { command: cmd, args };
        const pairs = env
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.includes('='));
        if (pairs.length) config.env = Object.fromEntries(pairs.map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1)]));
      }
    } catch (e) {
      setRefused(said(e));
      return;
    }
    await add(id.trim(), config);
  };

  const add = async (name: string, config: Record<string, unknown>) => {
    setBusy(true);
    try {
      const { servers } = await sendCommand<{ servers: McpServer[] }>({ type: 'mcp.add', brand, ...wireScope(scope), source, id: name, config });
      onAdded(servers);
      setOpen(false);
      setId('');
      setCommand('');
      setUrl('');
      setEnv('');
      setJson('');
    } catch (e) {
      setRefused(said(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="mcp-add">
        <Plus /> Add server
      </Button>
    );
  }
  return (
    <Panel className="space-y-3" data-testid="mcp-add-form">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input aria-label="Server name" placeholder="name" value={id} onChange={(e) => setId(e.target.value)} className="font-mono text-xs sm:w-48" data-testid="mcp-add-id" />
        <Select value={how} onValueChange={(v) => setHow(v as typeof how)}>
          <SelectTrigger className="sm:w-36" aria-label="Kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="command">Command</SelectItem>
            <SelectItem value="url">URL</SelectItem>
            <SelectItem value="json">JSON</SelectItem>
          </SelectContent>
        </Select>
        {sources.length > 1 && (
          <Select value={source} onValueChange={(v) => setSource(v as McpSource)}>
            <SelectTrigger className="sm:w-52" aria-label="Where">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sources.map((s) => (
                <SelectItem key={s} value={s}>
                  {SOURCE_NAME[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {how === 'command' && (
        <>
          <Input aria-label="Command" placeholder="npx -y @scope/server --flag" value={command} onChange={(e) => setCommand(e.target.value)} className="font-mono text-xs" data-testid="mcp-add-command" />
          <Textarea aria-label="Environment" placeholder="API_KEY=…" value={env} onChange={(e) => setEnv(e.target.value)} rows={2} className="font-mono text-xs" spellCheck={false} />
        </>
      )}
      {how === 'url' && <Input aria-label="URL" placeholder="https://…/mcp" value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono text-xs" data-testid="mcp-add-url" />}
      {how === 'json' && <Textarea aria-label="JSON" placeholder='{ "command": "…", "args": [] }' value={json} onChange={(e) => setJson(e.target.value)} rows={5} className="font-mono text-xs" spellCheck={false} />}
      {refused && (
        <p role="alert" className="text-sm text-danger">
          {refused}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || (!id.trim() && how !== 'json')} onClick={() => void submit()} data-testid="mcp-add-submit">
          {busy && <Loader2 className="animate-spin" />} Add
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </Panel>
  );
}

export function McpServersPanel({ brand, scope }: { brand: Brand; scope: Scope }) {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [elsewhere, setElsewhere] = useState<McpElsewhere[]>([]);
  const [unread, setUnread] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { toast } = useToast();
  const scopeKey = JSON.stringify(scope);

  useEffect(() => {
    let live = true;
    setUnread(null);
    sendCommand<Listed>({ type: 'mcp.list', brand, ...wireScope(scope) })
      .then((r) => {
        if (!live) return;
        setServers(r.servers);
        setElsewhere(r.elsewhere ?? []);
      })
      .catch((e: unknown) => live && setUnread(said(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand, scopeKey, attempt]);

  // A sign-in finishes in the browser, so the list is read again when this
  // window gets the focus back.
  useEffect(() => {
    const again = () => setAttempt((n) => n + 1);
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, []);

  const act = useCallback(
    async (key: string, run: () => Promise<Listed | { started: boolean; url?: string }>, done?: string) => {
      setBusy(key);
      try {
        const r = await run();
        if ('servers' in r) {
          setServers(r.servers);
          setElsewhere(r.elsewhere ?? []);
        }
        else {
          if (r.url) window.open(r.url, '_blank', 'noopener');
          setAttempt((n) => n + 1);
        }
        if (done) toast({ title: done });
      } catch (e) {
        toast({ title: 'Not done', description: said(e), variant: 'destructive' });
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );

  if (unread) return <ReadFailed what="The MCP servers could not be read." why={unread} onRetry={() => setAttempt((n) => n + 1)} />;
  if (!servers) {
    return (
      <p className="flex items-center gap-2 p-3 text-sm text-t-tertiary">
        <Loader2 className="size-4 animate-spin" /> Reading…
      </p>
    );
  }

  const canToggle = brand === 'codex' || scope.kind === 'project';

  return (
    <div className="space-y-4" data-testid={`mcp-servers-${brand}`}>
      <SettingsGroup title="MCP servers" actions={<AddServer brand={brand} scope={scope} onAdded={setServers} />}>
        {servers.length === 0 && <p className="p-3 text-sm text-t-tertiary">None</p>}
        {servers.map((s) => {
          const key = `${s.source}:${s.id}`;
          const target = s.command ? [s.command, ...(s.args ?? [])].join(' ') : s.url ?? '';
          return (
            <div key={key} className="flex items-center gap-3 px-3 py-2" data-testid={`mcp-server-${s.id}`}>
              {canToggle ? (
                <Checkbox
                  aria-label={`${s.id} on`}
                  checked={s.enabled}
                  disabled={busy !== null}
                  onCheckedChange={(c) =>
                    void act(key, () => sendCommand({ type: 'mcp.set-enabled', brand, ...wireScope(scope), source: s.source, id: s.id, enabled: c === true }))
                  }
                  data-testid={`mcp-enabled-${s.id}`}
                />
              ) : (
                <span className="size-4" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-t-primary">{s.id}</span>
                  <Badge variant="outline" size="sm">
                    {s.transport}
                  </Badge>
                  {scope.kind === 'project' && (
                    <Badge variant="secondary" size="sm">
                      {SOURCE_NAME[s.source]}
                    </Badge>
                  )}
                  {s.approval === 'pending' && (
                    <Badge variant="warning" size="sm">
                      Not yet approved
                    </Badge>
                  )}
                  {s.auth && (
                    <Badge variant={s.auth === 'signedIn' ? 'success' : 'warning'} size="sm" data-testid={`mcp-auth-${s.id}`}>
                      {s.auth === 'signedIn' ? 'Signed in' : s.auth === 'expired' ? 'Sign-in expired' : 'Not signed in'}
                    </Badge>
                  )}
                  {busy === key && <Loader2 className="size-3 animate-spin text-t-muted" />}
                </div>
                <Tooltip label={target}>
                  <p className="truncate font-mono text-xs text-t-muted">{target}</p>
                </Tooltip>
              </div>
              {s.transport !== 'stdio' &&
                (s.auth === 'signedIn' ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void act(key, () => sendCommand({ type: 'mcp.logout', brand, ...wireScope(scope), id: s.id }), 'Signed out')}
                    data-testid={`mcp-logout-${s.id}`}
                  >
                    <LogOut /> Sign out
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void act(key, () => sendCommand({ type: 'mcp.login', brand, ...wireScope(scope), id: s.id }), 'Sign-in opened in the browser')}
                    data-testid={`mcp-login-${s.id}`}
                  >
                    <LogIn /> Sign in
                  </Button>
                ))}
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove ${s.id}`}
                disabled={busy !== null}
                onClick={() => void act(key, () => sendCommand({ type: 'mcp.remove', brand, ...wireScope(scope), source: s.source, id: s.id }), 'Removed')}
                data-testid={`mcp-remove-${s.id}`}
              >
                <Trash2 />
              </Button>
            </div>
          );
        })}
      </SettingsGroup>
      {elsewhere.length > 0 && (
        <SettingsGroup
          title="On another account"
          description="Each account loads only its own servers, so these are not available to a chat on this one."
          data-testid={`mcp-elsewhere-${brand}`}
        >
          {elsewhere.map((e) => {
            const s = e.server;
            const key = `elsewhere:${e.account}:${s.id}`;
            const target = s.command ? [s.command, ...(s.args ?? [])].join(' ') : s.url ?? '';
            return (
              <div key={key} className="flex items-center gap-3 px-3 py-2" data-testid={`mcp-elsewhere-${s.id}`}>
                <span className="size-4" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-t-secondary">{s.id}</span>
                    <Badge variant="outline" size="sm">
                      {s.transport}
                    </Badge>
                    <Badge variant="secondary" size="sm">
                      {e.accountName}
                    </Badge>
                    {busy === key && <Loader2 className="size-3 animate-spin text-t-muted" />}
                  </div>
                  <Tooltip label={target}>
                    <p className="truncate font-mono text-xs text-t-muted">{target}</p>
                  </Tooltip>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(
                      key,
                      () =>
                        sendCommand<Listed>({
                          type: 'mcp.add',
                          brand,
                          ...wireScope(scope),
                          source: 'user',
                          id: s.id,
                          config: s.config,
                        }),
                      `${s.id} added to this account`,
                    )
                  }
                  data-testid={`mcp-copy-here-${s.id}`}
                >
                  <Plus /> Add here
                </Button>
              </div>
            );
          })}
        </SettingsGroup>
      )}
    </div>
  );
}
