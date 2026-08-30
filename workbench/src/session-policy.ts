/** Atelier-owned session policy, supplied at runtime rather than installed into a provider home. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
function manifestText(cwd: string): string | null {
  const repository = join(cwd, '.atelier', 'project.toml');
  if (existsSync(repository)) return readFileSync(repository, 'utf8');
  const data = process.env.ATELIER_DATA_DIR;
  const identity = gitIdentity(cwd);
  if (!data || !identity) return null;
  const id = createHash('sha256').update(identity).digest('hex');
  const personal = join(data, 'projects', id, 'project.toml');
  return existsSync(personal) ? readFileSync(personal, 'utf8') : null;
}

export function isBeadsRegistered(cwd: string): boolean {
  return /^\s*use_beads\s*=\s*true\s*$/m.test(manifestText(cwd) ?? '');
}

function projectGuidance(cwd: string): string {
  const manifest = manifestText(cwd);
  if (!manifest) return 'This project has no Atelier project manifest.';
  const section = (name: string) => {
    const tail = manifest.slice(Math.max(0, manifest.search(new RegExp(`^\\[${name}\\]\\s*$`, 'm'))));
    const next = tail.slice(1).search(/^\[/m);
    return next < 0 ? tail : tail.slice(0, next + 1);
  };
  const value = (key: string, inSection?: string) => (inSection ? section(inSection) : manifest)
    .match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*$`, 'm'))?.[1] ?? '';
  const flag = (key: string, inSection?: string) => (inSection ? section(inSection) : manifest)
    .match(new RegExp(`^\\s*${key}\\s*=\\s*(true|false)\\s*$`, 'm'))?.[1] === 'true';
  const deployment = value('command', 'deployment');
  const lines = [
    `Project: ${value('display_name') || cwd}`,
    value('summary') && `Project context: ${value('summary')}`,
    value('completed_work_branch') && `Completed work branch: ${value('completed_work_branch')}`,
    value('evidence_requirements') && `Required evidence: ${value('evidence_requirements')}`,
    value('setup_command') && `Setup command: ${value('setup_command')}`,
    value('start_command') && `Start command: ${value('start_command')}`,
    value('build_command') && `Build command: ${value('build_command')}`,
    flag('visual_proof_for_ui_changes', 'verification')
      ? 'This project requires visual proof for interface changes.'
      : 'This project does not require visual proof for interface changes.',
    value('external_review', 'review') && `External review policy: ${value('external_review', 'review')}. This policy authorizes any review it allows; do not ask for separate permission.`,
    deployment && `Deployment command: ${deployment}`,
    deployment && flag('requires_confirmation', 'deployment') && 'Ask for explicit permission immediately before running the deployment command.',
  ].filter(Boolean);
  return lines.join('\n');
}

export function sessionPolicy(cwd: string): string {
  const root = skillsRoot();
  const parts = [`<!-- ${SESSION_POLICY_MARKER} -->`, bodyOf(join(root, 'atelier', 'SKILL.md')), projectGuidance(cwd)];
  if (isBeadsRegistered(cwd)) {
    parts.push(bodyOf(join(root, 'beads', 'SKILL.md')), 'This session is in a Beads-registered project.');
  } else {
    parts.push('This project does not use Beads. Do not use Beads, Beads cards, or the Beads lifecycle for its work.');
  }
  return parts.join('\n\n');
}
