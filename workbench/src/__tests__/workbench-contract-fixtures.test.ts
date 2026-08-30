/** @vitest-environment node */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LEGACY_MIGRATIONS, SCHEMA_CAPABILITIES } from '../store.ts';

type Fixture = {
  commands: Array<{ type: string }>;
  events: Array<{ type: string }>;
  watchFrames: Array<{ kind: string }>;
  legacyMigrations: Array<{ ordinal: number; contains: string }>;
  schemaCapabilities: string[];
};

const root = resolve(import.meta.dirname, '../../..');
const protocol = readFileSync(resolve(root, 'src/workbench/protocol.ts'), 'utf8');
const fixture = JSON.parse(readFileSync(
  resolve(root, 'server/tests/fixtures/workbench-contract.json'),
  'utf8',
)) as Fixture;

function section(from: string, through: string): string {
  const start = protocol.indexOf(from);
  const end = protocol.indexOf(through, start);
  if (start < 0 || end < 0) throw new Error(`protocol section ${from} .. ${through} is missing`);
  return protocol.slice(start, end);
}

function literals(source: string, field: 'type' | 'kind'): string[] {
  return [...source.matchAll(new RegExp(`${field}: '([^']+)'`, 'g'))]
    .map((match) => match[1]!)
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort();
}

const fixtureKinds = (rows: Array<Record<string, unknown>>, field: 'type' | 'kind') =>
  rows.map((row) => String(row[field])).sort();

describe('the checked workbench compatibility fixture', () => {
  it('has exactly one example of every browser command', () => {
    expect(fixtureKinds(fixture.commands, 'type')).toEqual(literals(
      section('export type WbpCommand =', 'export interface RestoreRow'),
      'type',
    ));
  });

  it('has exactly one example of every server event', () => {
    expect(fixtureKinds(fixture.events, 'type')).toEqual(literals(
      section('export type WbpEvent =', 'export type AgentKind'),
      'type',
    ));
  });

  it('has exactly one example of every app-wide live-stream frame', () => {
    expect(fixtureKinds(fixture.watchFrames, 'kind')).toEqual(literals(
      section('export type WatchFrame =', 'export interface LinkedChat'),
      'kind',
    ));
  });

  it('pins every positional migration and named schema capability', () => {
    expect(fixture.legacyMigrations.map((migration) => migration.ordinal))
      .toEqual(LEGACY_MIGRATIONS.map((_, index) => index + 1));
    for (const migration of fixture.legacyMigrations) {
      expect(LEGACY_MIGRATIONS[migration.ordinal - 1]).toContain(migration.contains);
    }
    expect(fixture.schemaCapabilities).toEqual(SCHEMA_CAPABILITIES.map(({ name }) => name));
  });
});
