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
});
