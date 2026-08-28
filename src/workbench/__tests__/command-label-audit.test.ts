import { describe, expect, it } from 'vitest';

import { auditCommandLabel, explicitCommandIntent } from '@/workbench/command-label-audit';

describe('command label evidence', () => {
  it('does not mistake a friendly sentence for proof that it is correct', () => {
    expect(auditCommandLabel('machinery/board/land --help', {
      said: 'Landed the change', kind: 'board', grave: false,
    })).toMatchObject({ status: 'contradiction', intent: 'help' });
  });

  it('verifies an explicit help intent only when the label says it read options', () => {
    expect(auditCommandLabel('machinery/board/land --help', {
      said: 'Read the land options', kind: 'read', grave: false,
    })).toEqual({ status: 'verified', intent: 'help' });
  });

  it('keeps ordinary friendly labels unverified', () => {
    expect(auditCommandLabel('git status', {
      said: 'Checked the working tree', kind: 'vcs', grave: false,
    })).toEqual({ status: 'unverified' });
  });

  it('distinguishes uncovered explicit intent from a false label', () => {
    expect(auditCommandLabel('unheard-of --version', null)).toEqual({ status: 'uncovered', intent: 'version' });
  });

  it('does not read help-looking quoted data as invocation intent', () => {
    expect(explicitCommandIntent("rg '--help' src")).toBeNull();
  });

  it('recognises dry runs and destructive commands independently', () => {
    expect(explicitCommandIntent('npm install --dry-run')).toBe('dry-run');
    expect(explicitCommandIntent('git reset --hard HEAD')).toBe('destructive');
    expect(explicitCommandIntent('kill -0 123')).toBeNull();
  });
});
