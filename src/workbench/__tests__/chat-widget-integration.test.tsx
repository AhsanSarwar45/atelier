import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Mentions } from '@/components/markdown-body';
import { foldAll } from '@/workbench/fold';
import type { WbpEvent } from '@/workbench/protocol';
import { TranscriptRow } from '@/workbench/transcript-rows';

const mentions: Mentions = { split: (text) => [{ kind: 'text', text }], card: () => null };
const source = `Numbers\n\n\`\`\`atelier-widget\n{"type":"metrics","items":[{"label":"Speed","value":"42 ms"}]}\n\`\`\``;

describe('chat widget integration', () => {
  it('folds a durable widget event onto its message and hides valid source text', () => {
    const base = { seq: 1, sessionId: 'chat', at: '2026-08-26T00:00:00.000Z' };
    const events: WbpEvent[] = [
      { ...base, type: 'message.started', messageId: 'answer', role: 'assistant' },
      { ...base, seq: 2, type: 'text.delta', messageId: 'answer', text: source },
      { ...base, seq: 3, type: 'widget', messageId: 'answer', widget: { type: 'metrics', items: [{ label: 'Speed', value: '42 ms' }] } },
      { ...base, seq: 4, type: 'message.completed', messageId: 'answer' },
    ];
    const item = foldAll(events).items.find((entry) => entry.kind === 'message');
    expect(item).toMatchObject({ widgets: [{ type: 'metrics' }] });
    render(<TranscriptRow item={item!} sessionId="chat" mentions={mentions} onLook={vi.fn()} />);
    expect(screen.getByText('42 ms')).toBeVisible();
    expect(screen.getByText('Numbers')).toBeVisible();
    expect(screen.getByText('Numbers').compareDocumentPosition(screen.getByTestId('chat-widget'))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/atelier-widget/)).not.toBeInTheDocument();
  });

  it('restores an explainer from its durable widget event', () => {
    const base = { seq: 1, sessionId: 'chat', at: '2026-08-26T00:00:00.000Z' };
    const explainer = { type: 'explainer' as const, title: 'Request path', nodes: [{ id: 'ui', label: 'UI' }, { id: 'api', label: 'API' }], edges: [{ from: 'ui', to: 'api' }], steps: [{ label: 'Send request', active: ['ui'] }, { label: 'Read response', active: ['api'] }] };
    const events: WbpEvent[] = [
      { ...base, type: 'message.started', messageId: 'answer', role: 'assistant' },
      { ...base, seq: 2, type: 'text.delta', messageId: 'answer', text: `Here is the flow.\n\n\`\`\`atelier-widget\n${JSON.stringify(explainer)}\n\`\`\`` },
      { ...base, seq: 3, type: 'widget', messageId: 'answer', widget: explainer },
      { ...base, seq: 4, type: 'message.completed', messageId: 'answer' },
    ];
    const item = foldAll(events).items.find((entry) => entry.kind === 'message');
    render(<TranscriptRow item={item!} sessionId="chat" mentions={mentions} onLook={vi.fn()} />);
    expect(screen.getByRole('img', { name: 'Request path flow diagram, step 1 of 2' })).toBeVisible();
    expect(screen.getByText('Send request')).toBeVisible();
  });
});
