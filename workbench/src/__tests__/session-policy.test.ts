import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { codexThreadOpenRequest } from '../drivers/codex.ts';
import { isBeadsRegistered, SESSION_POLICY_MARKER, sessionPolicy } from '../session-policy.ts';

const priorData = process.env.ATELIER_DATA_DIR;
const priorRules = process.env.ATELIER_RULES_DIR;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (priorData === undefined) delete process.env.ATELIER_DATA_DIR;
  else process.env.ATELIER_DATA_DIR = priorData;
  if (priorRules === undefined) delete process.env.ATELIER_RULES_DIR;
  else process.env.ATELIER_RULES_DIR = priorRules;
});

function fixture(registered: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'atelier-policy-'));
  roots.push(root);
  const project = join(root, 'project');
  mkdirSync(project);
  mkdirSync(join(project, '.atelier'));
  writeFileSync(join(project, '.atelier', 'project.toml'), `schema_version = 1\n[project]\ndisplay_name = "Example"\nuse_beads = ${registered}\n`);
  process.env.ATELIER_DATA_DIR = root;
  process.env.ATELIER_RULES_DIR = resolve('.');
  return project;
}

describe('runtime session policy', () => {
  it('injects Atelier once and Beads only for a registered project', () => {
    const project = fixture(true);
    const policy = sessionPolicy(project);
    expect(policy.match(new RegExp(SESSION_POLICY_MARKER, 'g'))).toHaveLength(1);
    expect(policy).toContain('# Atelier');
    expect(policy).toContain('# Atelier workflow');
    expect(isBeadsRegistered(project)).toBe(true);
  });

  it('marks an unregistered project chat-only', () => {
    const project = fixture(false);
    const policy = sessionPolicy(project);
    expect(policy).toContain('# Atelier');
    expect(policy).not.toContain('# Atelier workflow');
    expect(policy).toContain('does not use Beads');
  });

  it('hands the same policy to Codex as developer instructions', () => {
    const policy = 'one canonical policy';
    const request = codexThreadOpenRequest({
      cwd: '/repo', approvalPolicy: 'on-request', instructions: policy,
    });
    expect(request.params.config.developer_instructions).toBe(policy);
  });
});
