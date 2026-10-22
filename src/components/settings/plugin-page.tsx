/**
 * A plugin's page: what it is, who makes it, what it adds and its README,
 * for an installed plugin and for one in the catalogue alike (bw-moh1k.1).
 */
'use client';

import { useEffect, useState, type ReactNode } from 'react';

import { Store } from 'lucide-react';

import { ItemPage, Link, type PartGroup } from '@/components/settings/item-page';
import { wireScope } from '@/components/settings/mcp-servers-panel';
import { shelfName } from '@/components/settings/plugin-catalogue';
import type { Scope } from '@/components/settings/provider-settings-api';
import { Badge } from '@/components/ui/badge';
import { ReadFailed } from '@/components/ui/read-failed';
import type { Brand, PluginDetail } from '@/workbench/protocol';
import { sendCommand } from '@/workbench/use-session';

/** What the list already knows, drawn while the page is read. */
export interface PluginSummary {
  id: string;
  name: string;
  title?: string;
  description?: string;
  version?: string;
  marketplace?: string;
}

function said(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function PluginPage({
  brand,
  scope,
  summary,
  actions,
  onBack,
  backLabel = 'Plugins',
  onServer,
  wide,
}: {
  brand: Brand;
  scope: Scope;
  summary: PluginSummary;
  actions?: ReactNode;
  onBack: () => void;
  backLabel?: string;
  /** Opens one of the plugin's MCP servers on the MCP servers tab. */
  onServer?: (name: string) => void;
  wide?: boolean;
}) {
  const [detail, setDetail] = useState<PluginDetail | null>(null);
  const [unread, setUnread] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const scopeKey = JSON.stringify(scope);

  useEffect(() => {
    let live = true;
    setUnread(null);
    setDetail(null);
    sendCommand<PluginDetail>({ type: 'plugin.detail', brand, ...wireScope(scope), id: summary.id })
      .then((d) => live && setDetail(d))
      .catch((e: unknown) => live && setUnread(said(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand, scopeKey, summary.id, attempt]);

  const d = detail;
  const version = d?.version || summary.version;
  const marketplace = d?.marketplace || summary.marketplace;
  const c = d?.contents;
  const groups: PartGroup[] = c
    ? [
        { label: 'Commands', parts: c.commands.map((p) => ({ ...p, name: `/${p.name}` })) },
        { label: 'Skills', parts: c.skills },
        { label: 'Agents', parts: c.agents },
        {
          label: 'MCP servers',
          parts: c.mcpServers.map((s) => ({ name: s.name, description: s.target, onOpen: onServer && d?.installed ? () => onServer(s.name) : undefined })),
        },
        { label: 'Apps', parts: c.apps },
        { label: 'Hooks', parts: c.hooks.map((h) => ({ name: h })) },
      ]
    : [];

  return (
    <ItemPage
      kind="plugin"
      title={d?.title || summary.title || d?.name || summary.name}
      byline={d?.author ? `By ${d.author}` : undefined}
      badges={
        <>
          {version && (
            <Badge variant="outline" size="sm">
              {version}
            </Badge>
          )}
          {marketplace && (
            <Badge variant="outline" size="sm">
              <Store /> {marketplace}
            </Badge>
          )}
          {d?.category && (
            <Badge variant="secondary" size="sm">
              {shelfName(d.category)}
            </Badge>
          )}
        </>
      }
      actions={actions}
      description={d?.description || summary.description}
      longDescription={d?.longDescription}
      readme={d?.readme}
      readmeBase={d?.readmeBase}
      readmeLoading={!d && !unread}
      facts={[
        { label: 'Name', value: <span className="font-mono text-xs">{summary.id}</span> },
        { label: 'Author', value: d?.author },
        { label: 'Version', value: version },
        { label: 'License', value: d?.license },
        { label: 'Website', value: d?.homepage && <Link href={d.homepage} /> },
        { label: 'Source', value: d?.repository && <Link href={d.repository} /> },
        { label: 'Privacy', value: d?.privacyPolicy && <Link href={d.privacyPolicy}>Privacy policy</Link> },
        { label: 'Terms', value: d?.terms && <Link href={d.terms}>Terms of service</Link> },
        { label: 'Keywords', value: d?.keywords && d.keywords.length > 0 ? d.keywords.join(', ') : undefined },
      ]}
      groups={groups}
      backLabel={backLabel}
      onBack={onBack}
      wide={wide}
      testId="plugin-page"
    >
      {unread && <ReadFailed what="Details unavailable" why={unread} onRetry={() => setAttempt((n) => n + 1)} />}
    </ItemPage>
  );
}
