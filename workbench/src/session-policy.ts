/** Atelier-owned session policy, supplied at runtime rather than installed into a provider home. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SESSION_POLICY_VERSION = 1;
export const SESSION_POLICY_MARKER = `ATELIER_SESSION_POLICY_V${SESSION_POLICY_VERSION}`;

function bodyOf(path: string): string {
  const text = readFileSync(path, 'utf8');
  if (!text.startsWith('---\n')) return text.trim();
  const end = text.indexOf('\n---\n', 4);
  return (end < 0 ? text : text.slice(end + 5)).trim();
}

function skillsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.ATELIER_RULES_DIR && join(process.env.ATELIER_RULES_DIR, 'machinery', 'skills'),
    process.env.ATELIER_DATA_DIR && join(process.env.ATELIER_DATA_DIR, 'rules', 'machinery', 'skills'),
    resolve(here, '../../machinery/skills'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const root = candidates.find((candidate) => existsSync(join(candidate, 'atelier', 'SKILL.md')));
  if (!root) throw new Error('Session policy unavailable. Reinstall Atelier.');
  return root;
}

function gitIdentity(path: string): string | null {
  try {
    const common = execFileSync('git', ['-C', path, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
    }).trim();
    return realpathSync(resolve(path, common));
  } catch { return null; }
}

/** Read only the [projects] string paths written by machinery/project.py. */
function registeredRoots(): string[] {
  const data = process.env.ATELIER_DATA_DIR;
  if (!data) return [];
  const registry = join(data, 'projects.toml');
  if (!existsSync(registry)) return [];
  const text = readFileSync(registry, 'utf8');
  const start = text.search(/^\[projects\]\s*$/m);
  if (start < 0) return [];
  const tail = text.slice(start).replace(/^\[projects\]\s*$/m, '');
  const next = tail.search(/^\[/m);
  const section = next < 0 ? tail : tail.slice(0, next);
  return [...section.matchAll(/^\s*[^#=]+?\s*=\s*(["'])(.*?)\1\s*(?:#.*)?$/gm)]
    .map((match) => match[2]!)
    .filter(Boolean);
}

export function isBeadsRegistered(cwd: string): boolean {
  let here: string;
  try { here = realpathSync(cwd); } catch { return false; }
  const identity = gitIdentity(here);
  return registeredRoots().some((root) => {
    try {
      const registered = realpathSync(root);
      return registered === here || (identity !== null && gitIdentity(registered) === identity);
    } catch { return false; }
  });
}

export function sessionPolicy(cwd: string): string {
  const root = skillsRoot();
  const parts = [`<!-- ${SESSION_POLICY_MARKER} -->`, bodyOf(join(root, 'atelier', 'SKILL.md'))];
  if (isBeadsRegistered(cwd)) {
    parts.push(bodyOf(join(root, 'beads', 'SKILL.md')), 'This session is in a Beads-registered project.');
  } else {
    parts.push('This session is not in a Beads-registered project. Do not use Beads for its work.');
  }
  return parts.join('\n\n');
}
