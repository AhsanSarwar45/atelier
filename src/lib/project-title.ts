import { PRODUCT_NAME } from '@/lib/identity';

const STORED_NAMES = 'atelier.project-names';

function storedNames(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const value = JSON.parse(window.localStorage.getItem(STORED_NAMES) || '{}');
    return value && typeof value === 'object' ? value as Record<string, string> : {};
  } catch {
    return {};
  }
}

/** Remember enough identity to name a project tab before its next server read. */
export function rememberProjectName(id: string, name: string): void {
  if (typeof window === 'undefined' || !id || !name.trim()) return;
  try {
    window.localStorage.setItem(STORED_NAMES, JSON.stringify({ ...storedNames(), [id]: name.trim() }));
  } catch {
    // A disabled/full browser store must not stop navigation.
  }
}

/** The stable browser-tab title for a project while its record is loading. */
export function projectTitle(id: string | null, name?: string | null): string {
  const fetched = name?.trim();
  if (id && fetched) rememberProjectName(id, fetched);
  const known = fetched || (id ? storedNames()[id] : undefined);
  return known ? `${known} | ${PRODUCT_NAME}` : PRODUCT_NAME;
}
