/** @vitest-environment node */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SessionSummary } from '../../../src/workbench/protocol.ts';
import { Store } from '../store.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function session(id: string): SessionSummary & { origin: string } {
  return {
    id, brand: 'codex', externalId: null, projectId: 'p', projectPath: '/p', cwd: '/p',
    model: null, permissionMode: 'default', effort: null, title: id, state: 'dormant',
    createdAt: '2026-08-29T00:00:00Z', lastActiveAt: '2026-08-29T00:00:00Z', origin: 'app',
  };
}

describe('the app-wide chat snapshot card links', () => {
  it('reads links for 152 chats in one query', () => {
    const root = mkdtempSync(join(tmpdir(), 'watch-snapshot-links-'));
    roots.push(root);
    const store = new Store(join(root, 'workbench.db'));
    const sessions = Array.from({ length: 152 }, (_, index) => session(`s-${index}`));
    for (const row of sessions) store.createSession(row);
    for (let index = 0; index < 877; index += 1) {
      store.rememberBeadLink(sessions[index % sessions.length]!.id, `bw-${index}`, 'test');
    }
    const internal = store as unknown as { db: { prepare: (sql: string) => unknown } };
    const prepare = internal.db.prepare.bind(internal.db);
    let linkQueries = 0;
    internal.db.prepare = ((sql: string) => {
      if (sql.includes('FROM bead_link')) linkQueries += 1;
      return prepare(sql);
    }) as typeof internal.db.prepare;

    const grouped = store.beadsForSessions(sessions.map((row) => row.id));

    expect(linkQueries).toBe(1);
    expect([...grouped.values()].flat()).toHaveLength(877);
    expect(grouped.get('s-0')?.[0]).toBe('bw-0');
    store.close();
  });
});
