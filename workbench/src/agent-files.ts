import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { claudeConfigDir } from './running.ts';

export type AgentFileProvider = 'claude' | 'codex';
export type AgentFileScope = 'personal' | 'project' | 'project-local';
export type AgentFileCategory = 'instructions' | 'settings' | 'agents' | 'commands' | 'skills' | 'output-styles' | 'rules';

export interface AgentFile {
  id: string;
  provider: AgentFileProvider;
  scope: AgentFileScope;
  category: AgentFileCategory;
  name: string;
  path: string;
  relativePath: string;
  format: 'markdown' | 'json' | 'toml' | 'yaml' | 'text';
  legacy?: boolean;
  size: number;
  modifiedAt: string;
  symlinkTarget?: string;
}

const SKIP = new Set(['.git', 'node_modules', '.next', 'target', 'dist', 'build']);
const MAX_FILES = 2_000;
const MAX_READ = 2 * 1024 * 1024;

function formatOf(path: string): AgentFile['format'] {
  switch (extname(path).toLowerCase()) {
    case '.md': return 'markdown';
    case '.json': return 'json';
    case '.toml': return 'toml';
    case '.yaml': case '.yml': return 'yaml';
    default: return 'text';
  }
}

function inside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function filesBelow(root: string, accept: (path: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visited = new Set<string>();
  const visit = (dir: string) => {
    if (out.length >= MAX_FILES) return;
    let real: string;
    try { real = realpathSync(dir); } catch { return; }
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isSymbolicLink()) {
        try {
          if (statSync(path).isDirectory()) visit(path);
          else if (accept(path)) out.push(path);
        } catch { /* A dangling provider entry is not a readable agent file. */ }
      } else if (entry.isFile() && accept(path)) out.push(path);
      if (out.length >= MAX_FILES) break;
    }
  };
  visit(root);
  return out;
}

interface Location {
  provider: AgentFileProvider;
  scope: AgentFileScope;
  category: AgentFileCategory;
  root: string;
  files: string[];
  legacy?: boolean;
}

function existing(...paths: string[]): string[] { return paths.filter((path) => existsSync(path) && statSync(path).isFile()); }
function all(root: string, extensions?: string[]): string[] {
  return filesBelow(root, (path) => !extensions || extensions.includes(extname(path).toLowerCase()));
}

function locations(projectPath?: string, home = homedir()): Location[] {
  const claude = process.env.CLAUDE_CONFIG_DIR || (home === homedir() ? claudeConfigDir() : join(home, '.claude'));
  const codex = process.env.CODEX_HOME || join(home, '.codex');
  const userSkills = join(home, '.agents', 'skills');
  const rows: Location[] = [
    { provider: 'claude', scope: 'personal', category: 'instructions', root: claude, files: existing(join(claude, 'CLAUDE.md')) },
    { provider: 'claude', scope: 'personal', category: 'settings', root: claude, files: existing(join(claude, 'settings.json')) },
    { provider: 'claude', scope: 'personal', category: 'rules', root: join(claude, 'rules'), files: all(join(claude, 'rules'), ['.md']) },
    { provider: 'claude', scope: 'personal', category: 'agents', root: join(claude, 'agents'), files: all(join(claude, 'agents'), ['.md']) },
    { provider: 'claude', scope: 'personal', category: 'commands', root: join(claude, 'commands'), files: all(join(claude, 'commands'), ['.md']), legacy: true },
    { provider: 'claude', scope: 'personal', category: 'skills', root: join(claude, 'skills'), files: all(join(claude, 'skills')) },
    { provider: 'claude', scope: 'personal', category: 'output-styles', root: join(claude, 'output-styles'), files: all(join(claude, 'output-styles'), ['.md']) },
    { provider: 'codex', scope: 'personal', category: 'instructions', root: codex, files: existing(join(codex, 'AGENTS.md'), join(codex, 'AGENTS.override.md')) },
    { provider: 'codex', scope: 'personal', category: 'settings', root: codex, files: [...existing(join(codex, 'config.toml')), ...all(codex, ['.toml']).filter((p) => basename(p).endsWith('.config.toml'))] },
    { provider: 'codex', scope: 'personal', category: 'agents', root: join(codex, 'agents'), files: all(join(codex, 'agents'), ['.toml']) },
    { provider: 'codex', scope: 'personal', category: 'rules', root: join(codex, 'rules'), files: all(join(codex, 'rules'), ['.rules']) },
    { provider: 'codex', scope: 'personal', category: 'skills', root: userSkills, files: all(userSkills) },
  ];
  if (!projectPath) return rows;
  const project = resolve(projectPath);
  rows.push(
    { provider: 'claude', scope: 'project', category: 'instructions', root: project, files: existing(join(project, 'CLAUDE.md'), join(project, '.claude', 'CLAUDE.md')) },
    { provider: 'claude', scope: 'project-local', category: 'instructions', root: project, files: existing(join(project, 'CLAUDE.local.md')) },
    { provider: 'claude', scope: 'project', category: 'settings', root: join(project, '.claude'), files: existing(join(project, '.claude', 'settings.json')) },
    { provider: 'claude', scope: 'project-local', category: 'settings', root: join(project, '.claude'), files: existing(join(project, '.claude', 'settings.local.json')) },
    ...(['rules', 'agents', 'commands', 'skills', 'output-styles'] as const).map((category) => ({ provider: 'claude' as const, scope: 'project' as const, category, root: join(project, '.claude', category), files: all(join(project, '.claude', category), category === 'skills' ? undefined : ['.md']), legacy: category === 'commands' || undefined })),
    { provider: 'codex', scope: 'project', category: 'instructions', root: project, files: filesBelow(project, (p) => ['AGENTS.md', 'AGENTS.override.md'].includes(basename(p))) },
    { provider: 'codex', scope: 'project', category: 'settings', root: join(project, '.codex'), files: existing(join(project, '.codex', 'config.toml')) },
    { provider: 'codex', scope: 'project', category: 'agents', root: join(project, '.codex', 'agents'), files: all(join(project, '.codex', 'agents'), ['.toml']) },
    { provider: 'codex', scope: 'project', category: 'skills', root: join(project, '.agents', 'skills'), files: all(join(project, '.agents', 'skills')) },
  );
  return rows;
}

export function discoverAgentFiles(projectPath?: string, home = homedir()): AgentFile[] {
  const seen = new Set<string>();
  return locations(projectPath, home).flatMap<AgentFile>((location) => location.files.flatMap<AgentFile>((path) => {
    const absolute = resolve(path);
    if (seen.has(`${location.provider}:${location.scope}:${absolute}`)) return [];
    seen.add(`${location.provider}:${location.scope}:${absolute}`);
    let stat;
    try { stat = statSync(absolute); } catch { return []; }
    const link = lstatSync(absolute).isSymbolicLink();
    return [{
      id: Buffer.from(`${location.provider}\0${location.scope}\0${absolute}`).toString('base64url'),
      provider: location.provider, scope: location.scope, category: location.category,
      name: basename(absolute), path: absolute, relativePath: relative(location.root, absolute) || basename(absolute),
      format: formatOf(absolute), legacy: location.legacy, size: stat.size, modifiedAt: stat.mtime.toISOString(),
      ...(link ? { symlinkTarget: realpathSync(absolute) } : {}),
    } satisfies AgentFile];
  })).sort((a, b) => a.provider.localeCompare(b.provider) || a.scope.localeCompare(b.scope) || a.category.localeCompare(b.category) || a.relativePath.localeCompare(b.relativePath));
}

export function readAgentFile(path: string, projectPath?: string): { content: string; truncated: boolean } {
  const allowed = discoverAgentFiles(projectPath).some((file) => file.path === resolve(path));
  if (!allowed) throw new Error('That file is not part of the discovered agent configuration');
  const size = statSync(path).size;
  if (size > MAX_READ) return { content: readFileSync(path).subarray(0, MAX_READ).toString('utf8'), truncated: true };
  return { content: readFileSync(path, 'utf8'), truncated: false };
}
