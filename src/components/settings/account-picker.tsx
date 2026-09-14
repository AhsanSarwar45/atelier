/**
 * Which of a brand's accounts a settings page is about.
 *
 * Every account has its own settings, MCP servers, plugins and files, so the
 * page cannot be drawn until one is chosen. The choice is in the address
 * (`&account=<id>`) so a link opens the right one; nothing chosen means the
 * account the server booted with (bw-2t1c.4).
 */
'use client';

import { useEffect, useState } from 'react';

import type { Brand } from '@/components/settings/provider-schema';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SYSTEM_PROFILE, type ProfileChoice } from '@/workbench/protocol';
import { sendCommand } from '@/workbench/use-session';

export function useProfiles(brand: Brand): { profiles: ProfileChoice[] | null; unread: string | null } {
  const [profiles, setProfiles] = useState<ProfileChoice[] | null>(null);
  const [unread, setUnread] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    sendCommand<{ profiles: ProfileChoice[] }>({ type: 'profiles.list', brand })
      .then((r) => live && setProfiles(r.profiles))
      .catch((e: unknown) => live && setUnread(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [brand]);
  return { profiles, unread };
}

export function AccountPicker({
  brand,
  profiles,
  value,
  onChange,
}: {
  brand: Brand;
  profiles: ProfileChoice[];
  /** The chosen profile id; the system account when none is named. */
  value: string | null;
  onChange: (profileId: string) => void;
}) {
  const chosen = value ?? SYSTEM_PROFILE;
  return (
    <Select value={chosen} onValueChange={onChange}>
      <SelectTrigger className="w-full sm:w-64" aria-label="Account" data-testid={`account-picker-${brand}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {profiles.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
