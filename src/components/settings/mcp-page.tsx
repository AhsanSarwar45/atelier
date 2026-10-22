/**
 * An MCP server's page: what it is for, how it runs, whether it is signed in,
 * where its source lives and its README, for a server already added and for
 * one in the catalogue alike (bw-moh1k.2).
 */
'use client';

import { useEffect, useState, type ReactNode } from 'react';

import { ItemPage, Link, type Fact } from '@/components/settings/item-page';
import { shelfName } from '@/components/settings/mcp-catalogue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { McpCatalogueEntry, McpDetail, McpServer } from '@/workbench/protocol';
import { sendCommand } from '@/workbench/use-session';

/** What a page says about a server, whichever list it was opened from. */
export interface McpInfo {
  name: string;
  title?: string;
  description?: string;
  icon?: string;
  repository?: string;
  category?: string;
  transport: string;
  /** The command line, or the address it is reached at. */
  runs?: string;
  /** Where it comes from: Account, Project, a plugin, claude.ai. */
  from?: ReactNode;
  /** The plugin it comes with, which the page links to. */
  plugin?: string;
  auth?: McpServer['auth'];
  approval?: McpServer['approval'];
  /** The names of the variables it is given or needs; never their values. */
  variables?: { name: string; description?: string }[];
  container?: boolean;
}

export function infoOfServer(s: McpServer, name: string, from: string): McpInfo {
  const vars = Object.keys(s.env ?? {}).map((n) => ({ name: n }));
  return {
    name,
    title: s.title,
    description: s.description,
    icon: s.icon,
    repository: s.repository,
    transport: s.transport,
    runs: s.source === 'connector' ? undefined : s.command ? [s.command, ...(s.args ?? [])].join(' ') : s.url,
    from,
    plugin: s.plugin,
    auth: s.auth,
    approval: s.approval,
    variables: vars,
  };
}

export function infoOfEntry(e: McpCatalogueEntry): McpInfo {
  return {
    name: e.id,
    title: e.title,
    description: e.description,
    icon: e.icon,
    repository: e.repository,
    category: e.category,
    transport: e.transport,
    runs: e.command ? [e.command, ...(e.args ?? [])].join(' ') : e.url,
    container: e.container,
  };
}

const AUTH: Record<NonNullable<McpServer['auth']>, string> = {
  signedIn: 'Signed in',
  notSignedIn: 'Not signed in',
  expired: 'Sign-in expired',
};

export function McpPage({
  info,
  actions,
  onBack,
  backLabel,
  onPlugin,
  wide,
  children,
}: {
  info: McpInfo;
  actions?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  /** Opens the plugin this server comes with. */
  onPlugin?: (plugin: string) => void;
  wide?: boolean;
  children?: ReactNode;
}) {
  const [detail, setDetail] = useState<McpDetail | null>(null);
  const repository = info.repository;

  useEffect(() => {
    let live = true;
    setDetail(null);
    if (!repository) return;
    sendCommand<McpDetail>({ type: 'mcp.detail', repository })
      .then((d) => live && setDetail(d))
      .catch((e: unknown) => live && setDetail({ unread: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [repository]);

  const facts: Fact[] = [
    { label: 'Name', value: <span className="font-mono text-xs">{info.name}</span> },
    { label: 'From', value: info.from },
    {
      label: 'Plugin',
      value:
        info.plugin &&
        (onPlugin ? (
          <Button mode="link" size="inherit" className="text-info underline-offset-4 hover:underline" onClick={() => onPlugin(info.plugin!)} data-testid="mcp-page-plugin">
            {info.plugin.split('@')[0]}
          </Button>
        ) : (
          info.plugin.split('@')[0]
        )),
    },
    { label: 'Category', value: info.category && shelfName(info.category) },
    { label: 'Transport', value: info.transport },
    { label: 'Runs', value: info.runs && <code className="break-all font-mono text-xs">{info.runs}</code> },
    { label: 'Sign-in', value: info.auth && AUTH[info.auth] },
    { label: 'Source', value: repository && <Link href={repository} /> },
  ];

  return (
    <ItemPage
      kind="server"
      icon={info.icon}
      title={info.title || info.name}
      badges={
        <>
          <Badge variant="outline" size="sm">
            {info.transport === 'stdio' ? 'Local' : 'Remote'}
          </Badge>
          {info.auth && (
            <Badge variant={info.auth === 'signedIn' ? 'success' : 'warning'} size="sm">
              {AUTH[info.auth]}
            </Badge>
          )}
          {info.approval === 'pending' && (
            <Badge variant="warning" size="sm">
              Not yet approved
            </Badge>
          )}
          {info.container && (
            <Badge variant="outline" size="sm">
              Needs Docker
            </Badge>
          )}
        </>
      }
      actions={actions}
      description={info.description}
      readme={detail?.readme}
      readmeLoading={!!repository && !detail}
      facts={facts}
      groups={info.variables && info.variables.length > 0 ? [{ label: 'Variables', parts: info.variables }] : []}
      backLabel={backLabel}
      onBack={onBack}
      wide={wide}
      testId="mcp-page"
    >
      {children}
    </ItemPage>
  );
}
