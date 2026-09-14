/**
 * The two commands that read and write a provider's settings files, and the
 * arithmetic over the layers they come back in.
 *
 * The server returns every file in the scope, parsed whole; this side decides
 * which one answers for a key (the effective value) and which one a change is
 * written to. A JSON `null` in a patch deletes the key.
 */
import type { Brand } from '@/components/settings/provider-schema';
import type { SettingsLayer } from '@/workbench/protocol';
import { sendCommand } from '@/workbench/use-session';

export type Layer = SettingsLayer;

export interface SettingsFile {
  layer: Layer;
  path: string;
  exists: boolean;
  writable: boolean;
  value: Record<string, unknown>;
}

export interface SettingsView {
  files: SettingsFile[];
}

export type Scope = { kind: 'account'; profileId?: string } | { kind: 'project'; projectPath: string };

/** Highest precedence first, as the provider itself reads them. */
const ORDER: Layer[] = ['managed', 'local', 'project', 'user'];

function wire(scope: Scope) {
  return scope.kind === 'account'
    ? { scope: 'account' as const, profileId: scope.profileId }
    : { scope: 'project' as const, projectPath: scope.projectPath };
}

export async function readSettings(brand: Brand, scope: Scope): Promise<SettingsView> {
  return sendCommand<SettingsView>({ type: 'provider-settings.read', brand, ...wire(scope) });
}

export async function writeSettings(
  brand: Brand,
  scope: Scope,
  layer: Layer,
  patch: Record<string, unknown>,
): Promise<SettingsView> {
  return sendCommand<SettingsView>({
    type: 'provider-settings.write',
    brand,
    ...wire(scope),
    layer,
    patch,
  });
}

export function getPath(value: unknown, key: string): unknown {
  let at: unknown = value;
  for (const part of key.split('.')) {
    if (!at || typeof at !== 'object') return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

/** The value a key resolves to across the files, and the file it came from. */
export function effective(view: SettingsView, key: string): { value: unknown; layer: Layer | null } {
  for (const layer of ORDER) {
    const file = view.files.find((f) => f.layer === layer);
    if (!file) continue;
    const value = getPath(file.value, key);
    if (value !== undefined) return { value, layer };
  }
  return { value: undefined, layer: null };
}

export function layerName(layer: Layer): string {
  switch (layer) {
    case 'managed':
      return 'Managed';
    case 'user':
      return 'Account';
    case 'project':
      return 'Project';
    case 'local':
      return 'Local';
  }
}
