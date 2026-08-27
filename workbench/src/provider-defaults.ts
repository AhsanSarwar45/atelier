import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Brand } from '../../src/workbench/protocol.ts';
import { claudeConfigDir } from './running.ts';

export interface ProviderDefaults { model: string | null; effort: string | null }

function jsonSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} is not a settings object`);
  return value as Record<string, unknown>;
}

function writeSettings(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.atelier-${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

function codexConfigPath(): string {
  return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
}

function tomlValue(text: string, key: string): string | null {
  const top = text.split(/^\s*\[/m, 1)[0] ?? '';
  const match = top.match(new RegExp(`^\\s*${key}\\s*=\\s*(["'])(.*?)\\1\\s*(?:#.*)?$`, 'm'));
  return match?.[2] ?? null;
}

function setTomlValue(text: string, key: string, value: string | null): string {
  const line = new RegExp(`^\\s*${key}\\s*=.*(?:\\r?\\n|$)`, 'm');
  const without = text.replace(line, '');
  if (value === null) return without;
  const setting = `${key} = ${JSON.stringify(value)}\n`;
  const table = without.search(/^\s*\[/m);
  return table < 0 ? `${without}${without && !without.endsWith('\n') ? '\n' : ''}${setting}` : `${without.slice(0, table)}${setting}${without.slice(table)}`;
}

export function readProviderDefaults(brand: Brand): ProviderDefaults {
  if (brand === 'claude') {
    const path = join(claudeConfigDir(), 'settings.json');
    const settings = jsonSettings(path);
    return {
      model: typeof settings.model === 'string' ? settings.model : null,
      effort: typeof settings.effortLevel === 'string' ? settings.effortLevel : null,
    };
  }
  const path = codexConfigPath();
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  return { model: tomlValue(text, 'model'), effort: tomlValue(text, 'model_reasoning_effort') };
}

export async function writeProviderDefault(brand: Brand, kind: 'model' | 'effort', value: string): Promise<ProviderDefaults> {
  if (brand === 'claude') {
    if (kind === 'effort' && value === 'max') throw new Error('Claude does not allow Max as a persisted default');
    const path = join(claudeConfigDir(), 'settings.json');
    const settings = jsonSettings(path);
    if (kind === 'model') {
      if (value === 'default') delete settings.model;
      else settings.model = value;
    } else settings.effortLevel = value;
    writeSettings(path, `${JSON.stringify(settings, null, 2)}\n`);
  } else {
    const path = codexConfigPath();
    let text = existsSync(path) ? readFileSync(path, 'utf8') : '';
    text = setTomlValue(text, kind === 'model' ? 'model' : 'model_reasoning_effort', kind === 'model' && value === 'default' ? null : value);
    writeSettings(path, text);
  }
  return readProviderDefaults(brand);
}
