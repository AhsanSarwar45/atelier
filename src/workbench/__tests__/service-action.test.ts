import { describe, expect, it } from 'vitest';

import { normalizeServiceAction, serviceIdentity } from '@/workbench/service-action';

describe('provider-neutral external service actions', () => {
  it('normalizes Claude, Codex, and native completion identities alike', () => {
    expect(serviceIdentity('mcp__claude_ai_Linear__get_issue')).toEqual({
      server: 'claude_ai_Linear', method: 'get_issue',
    });
    expect(normalizeServiceAction('mcp__claude_ai_Linear__get_issue', { id: 'KEY-1309' })?.summary)
      .toBe('Read Linear issue KEY-1309');
    expect(normalizeServiceAction('linear/get_issue', { id: 'KEY-1309' })?.summary)
      .toBe('Read Linear issue KEY-1309');
  });

  it.each([
    ['linear/list_comments', 'read', 'read-only', 'Listed Linear comments KEY-1'],
    ['notion/create_page', 'create', 'mutating', 'Created Notion page page-1'],
    ['gmail/send_message', 'communicate', 'mutating', 'Sent Gmail message message-1'],
    ['linear/update_issue', 'update', 'mutating', 'Updated Linear issue KEY-1'],
    ['gmail/delete_label', 'delete', 'destructive', 'Deleted Gmail label label-1'],
  ] as const)('classifies %s by capability rather than protocol', (name, effect, risk, summary) => {
    const input = name.includes('page') ? { pageId: 'page-1' }
      : name.includes('message') ? { id: 'message-1' }
        : name.includes('label') ? { id: 'label-1' }
          : { issueId: 'KEY-1' };
    expect(normalizeServiceAction(name, input)).toMatchObject({ effect, risk, summary });
  });

  it('uses annotations as evidence but never lets read-only lower destructive risk', () => {
    expect(normalizeServiceAction('gmail/delete_label', {}, { readOnlyHint: true })).toMatchObject({
      effect: 'delete', risk: 'destructive',
    });
    expect(normalizeServiceAction('inventory/inspect', {}, { readOnlyHint: true })).toMatchObject({
      effect: 'read', risk: 'read-only', confidence: 'schema',
    });
  });

  it('keeps an unknown capability unknown instead of styling it read-only', () => {
    expect(normalizeServiceAction('proxy/do_thing', {})).toMatchObject({
      effect: 'execute', risk: 'unknown', confidence: 'unknown',
    });
  });

  it('finds a capability after service namespaces and qualifiers', () => {
    expect(normalizeServiceAction('linear/issues_get', { issueId: 'KEY-2' })).toMatchObject({
      effect: 'read', risk: 'read-only', summary: 'Read Linear issues KEY-2',
    });
    expect(normalizeServiceAction('linear/batch_update_issues', {})).toMatchObject({
      effect: 'update', risk: 'mutating', summary: 'Updated Linear batch issues',
    });
  });

  it('does not call applying or labelling an update a creation', () => {
    expect(normalizeServiceAction('workspace/apply_patch', {})).toMatchObject({
      effect: 'update', risk: 'mutating', summary: 'Updated Workspace patch',
    });
    expect(normalizeServiceAction('linear/label_issue', { issueId: 'KEY-3' })).toMatchObject({
      effect: 'update', risk: 'mutating', summary: 'Updated Linear issue KEY-3',
    });
  });

  it('uses read-only schema evidence ahead of a heuristic mutating word', () => {
    expect(normalizeServiceAction('preview/create_preview', {}, { readOnlyHint: true })).toMatchObject({
      effect: 'read', risk: 'read-only', confidence: 'schema',
    });
  });
});
