/** @vitest-environment node */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PastEntry } from '../../../src/workbench/imported-history.ts';
import { IMPORT_RECIPE } from '../../../src/workbench/imported-history.ts';
import { spokenAsEvents } from '../reading-back.ts';

const said = (text: string, role: 'assistant' | 'user' = 'assistant'): Extract<PastEntry, { kind: 'said' }> =>
  ({ kind: 'said', role, text, images: [] });

describe('rich media when a chat is reopened', () => {
  it('rebuilds an image comparison from the assistant message stored by the provider', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'atelier-read-back-'));
    writeFileSync(join(cwd, 'before.png'), Buffer.from('before'));
    writeFileSync(join(cwd, 'after.png'), Buffer.from('after'));
    const text = '```atelier-image-compare\n{"mode":"side_by_side","before":{"path":"before.png"},"after":{"path":"after.png"}}\n```';

    const events = spokenAsEvents(said(text), 'answer', null, cwd);
    expect(events.find((event) => event.type === 'image.compare')).toMatchObject({
      messageId: 'answer', comparison: { mode: 'side_by_side' },
    });
  });

  it('rebuilds a structured widget from stored assistant text', () => {
    const text = '```atelier-widget\n{"type":"metrics","items":[{"label":"Tests","value":"20"}]}\n```';
    expect(spokenAsEvents(said(text), 'answer').map((event) => event.type)).toContain('widget');
  });

  it('does not interpret a manager-authored source example as a widget', () => {
    const text = '```atelier-widget\n{"type":"metrics","items":[{"label":"Tests","value":"20"}]}\n```';
    expect(spokenAsEvents(said(text, 'user'), 'question').map((event) => event.type)).not.toContain('widget');
  });

  it('forces chats imported before rich-media replay to be read again', () => {
    expect(IMPORT_RECIPE).toBeGreaterThanOrEqual(10);
  });
});
