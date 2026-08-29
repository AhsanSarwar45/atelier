import { describe, expect, it } from 'vitest';

import { auditCommandLabel, commandLabelProfile, explicitCommandIntent } from '@/workbench/command-label-audit';

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

  it('verifies structural labels with an independent command-family oracle', () => {
    expect(auditCommandLabel('git status', {
      said: 'Checked the working tree', kind: 'vcs', grave: false,
    })).toEqual({ status: 'verified', intent: 'git' });
  });

  it('distinguishes uncovered explicit intent from a false label', () => {
    expect(auditCommandLabel('unheard-of --version', null)).toEqual({ status: 'uncovered', intent: 'version' });
  });

  it('does not read help-looking quoted data as invocation intent', () => {
    expect(explicitCommandIntent("rg '--help' src")).toBeNull();
    expect(explicitCommandIntent('bd show bw-a\nmachinery/board/land --help')).toBeNull();
  });

  it('recognises dry runs and destructive commands independently', () => {
    expect(explicitCommandIntent('npm install --dry-run')).toBe('dry-run');
    expect(explicitCommandIntent('git reset --hard HEAD')).toBe('destructive');
    expect(explicitCommandIntent('git clean -n')).toBe('dry-run');
    expect(explicitCommandIntent('git clean -nd cache')).toBe('dry-run');
    expect(explicitCommandIntent('unlink old.txt')).toBe('destructive');
    expect(explicitCommandIntent('gio trash old.txt')).toBe('destructive');
    expect(explicitCommandIntent('kill -0 123')).toBeNull();
    expect(explicitCommandIntent('git -C /private/repo branch -d old')).toBe('destructive');
  });

  it('catches the recurring semantic mismatches found by the profile scan', () => {
    expect(auditCommandLabel('git -C /private/repo branch -d old', {
      said: 'Listed the branches', kind: 'vcs', grave: false,
    }).status).toBe('contradiction');
    expect(auditCommandLabel('next dev', {
      said: 'Started the app', kind: 'build', grave: false,
    }).status).toBe('contradiction');
    expect(auditCommandLabel('awk "{print $1}" private.tsv', {
      said: 'Picked fields out of a file', kind: 'edit', grave: false,
    }).status).toBe('contradiction');
  });

  it('profiles behavior without retaining command arguments', () => {
    expect(commandLabelProfile('git -C /private/repo push secret --force-with-lease', {
      said: 'Force-pushed', kind: 'grave', grave: true,
    })).toBe('git|push|--force-with-lease|Force-pushed|grave|grave');
    expect(commandLabelProfile("rg 'private phrase' /private/repo", {
      said: 'Searched for private phrase', kind: 'search', grave: false,
    })).toBe('rg|-|-|Searched|search|ordinary');
    expect(commandLabelProfile('bd update private --notes "--dry"', {
      said: 'Updated private', kind: 'board', grave: false,
    })).toBe('bd|update|value:--dry|Updated|board|ordinary');
    expect(commandLabelProfile('rtk proxy git -C /private/repo status', {
      said: 'Checked the working tree', kind: 'vcs', grave: false,
    })).toBe('git|status|-|Checked|vcs|ordinary');
    expect(commandLabelProfile('time curl https://private.example/path', {
      said: 'Fetched private.example/path', kind: 'net', grave: false,
    })).toBe('curl|-|-|Fetched|net|ordinary');
    expect(commandLabelProfile('NAME="/private/value" docker exec cache redis-cli -p 6390 GET private:key', {
      said: 'Read data from Redis', kind: 'data', grave: false,
    })).toBe('redis-cli|-|-|Read|data|ordinary');
    expect(commandLabelProfile('{ printf value > private.txt', {
      said: 'Wrote private.txt', kind: 'edit', grave: false,
    })).toBe('printf|-|-|Wrote|edit|ordinary');
  });
});
