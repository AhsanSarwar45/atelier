/**
 * One provider's settings section: the account it is about, then the pages
 * for that account — its defaults, its permissions, its MCP servers, its
 * extensions and its files.
 *
 * The same pages are drawn inside a project's settings with the project as the
 * scope; there the account picker is the project's own, so this component
 * takes the scope and draws only what changes with it (bw-2t1c.4, .5).
 */
'use client';

import type { ReactNode } from 'react';

import { AgentFilesBrowser } from '@/components/agent-files-browser';
import { AccountPicker, useProfiles } from '@/components/settings/account-picker';
import { CopyToAccounts } from '@/components/settings/copy-to-accounts';
import { ExtensionsPanel } from '@/components/settings/extensions-panel';
import { McpServersPanel } from '@/components/settings/mcp-servers-panel';
import { pagesFor, type Brand } from '@/components/settings/provider-schema';
import type { Scope } from '@/components/settings/provider-settings-api';
import { ProviderSettingsPanel } from '@/components/settings/provider-settings-panel';
import { ReadFailed } from '@/components/ui/read-failed';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useProjects } from '@/hooks/use-projects';
import { brandName } from '@/workbench/brand-icon';
import { SYSTEM_PROFILE } from '@/workbench/protocol';

export interface ProviderTabDef {
  id: string;
  label: string;
}

/** The pages every provider has, in reading order. */
export function providerTabs(brand: Brand): ProviderTabDef[] {
  return [
    ...pagesFor(brand).map((p) => ({ id: p.id, label: p.label })),
    { id: 'mcp', label: 'MCP servers' },
    { id: 'extensions', label: 'Extensions' },
    { id: 'files', label: 'Files' },
  ];
}

export function ProviderTabs({
  brand,
  tab,
  onOpen,
  children,
  tabs = providerTabs(brand),
}: {
  brand: Brand;
  tab: string;
  onOpen: (tab: string) => void;
  children?: ReactNode;
  /** A narrower set of tabs than the provider's full list. */
  tabs?: ProviderTabDef[];
}) {
  return (
    <Tabs value={tab} onValueChange={onOpen}>
      <TabsList className="flex h-auto w-full flex-wrap justify-start sm:h-9 sm:w-auto" data-testid={`provider-tabs-${brand}`}>
        {tabs.map((t) => (
          <TabsTrigger key={t.id} value={t.id} data-testid={`provider-tab-${t.id}`} className="flex-1 sm:flex-none">
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <div className="mt-4">{children}</div>
    </Tabs>
  );
}

/**
 * The account-scoped section on the settings screen.
 *
 * `pages` draws the tabs that are not plain settings pages (MCP, extensions,
 * files), given the chosen scope, so those screens live next to their own
 * server commands rather than here.
 */
export function ProviderSection({
  brand,
  account,
  tab,
  onAccount,
  onTab,
  pages,
}: {
  brand: Brand;
  account: string | null;
  tab: string;
  onAccount: (profileId: string) => void;
  onTab: (tab: string) => void;
  pages?: (scope: Scope, tab: string) => ReactNode;
}) {
  const { profiles, unread } = useProfiles(brand);
  const { projects } = useProjects();
  const scope: Scope = { kind: 'account', profileId: account ?? undefined };
  const known = providerTabs(brand).some((t) => t.id === tab) ? tab : providerTabs(brand)[0].id;
  const isPage = pagesFor(brand).some((p) => p.id === known);
  return (
    <div className="space-y-4" data-testid={`provider-section-${brand}`}>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-t-tertiary">Account</span>
        {unread ? (
          <ReadFailed what={`${brandName(brand)}'s accounts could not be listed.`} why={unread} />
        ) : profiles ? (
          <div className="flex items-center gap-2">
            <AccountPicker brand={brand} profiles={profiles} value={account} onChange={onAccount} />
            {isPage && <CopyToAccounts brand={brand} from={account ?? SYSTEM_PROFILE} profiles={profiles} page={known} />}
          </div>
        ) : (
          <span className="text-sm text-t-tertiary">Reading accounts…</span>
        )}
      </div>
      <ProviderTabs brand={brand} tab={known} onOpen={onTab}>
        {isPage ? (
          <ProviderSettingsPanel brand={brand} scope={scope} page={known} layer="user" />
        ) : known === 'files' ? (
          <div className="-mx-4 flex h-[70dvh] flex-col sm:-mx-6">
            <AgentFilesBrowser
              brand={brand}
              profileId={account}
              projects={projects
                .filter((project) => !project.archivedAt)
                .map(({ id, name, localPath, path }) => ({ id, name, path: localPath || path }))}
            />
          </div>
        ) : known === 'mcp' ? (
          <McpServersPanel brand={brand} scope={scope} />
        ) : known === 'extensions' ? (
          <ExtensionsPanel brand={brand} scope={scope} />
        ) : (
          pages?.(scope, known)
        )}
      </ProviderTabs>
    </div>
  );
}
