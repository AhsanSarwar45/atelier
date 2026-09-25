import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MarkdownBody, type Mentions } from '@/components/markdown-body';
import { ReferenceBadge, referenceBadgeElement, type Reference } from '@/components/reference-badge';
import { openableIn } from '@/workbench/mentions';
import type { AtelierKind } from '@/workbench/references';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams('id=p1&tab=chat'),
}));

const CHAT = '0b8f6c1e-2d3a-4f5b-9c7d-1e2f3a4b5c6d';

function describeRef(kind: AtelierKind, id: string): Reference {
  if (kind === 'bead') return { kind, id, status: 'in_progress' };
  if (kind === 'chat') return { kind, id, name: 'Standup notes', brand: 'claude', projectId: 'p2' };
  return { kind, id, name: 'Standup', description: 'Write the standup' };
}

const MENTIONS: Mentions = {
  split: (text) => openableIn(text, { card: () => false }, { cwd: '/p', home: '/h' }, { real: () => false, ask: () => {} } as never),
  card: (id) => <ReferenceBadge reference={describeRef('bead', id)} projectId="p1" testId="mention-card" />,
  reference: (kind, id) => <ReferenceBadge reference={describeRef(kind, id)} projectId="p1" testId={`mention-${kind}`} />,
};

/** The badge's own box — its classes and what is inside it — without the control around it. */
function face(el: Element): { classes: string[]; inside: string } {
  return { classes: el.className.split(/\s+/).filter((c) => !c.startsWith('relative') && !c.startsWith('before:')).filter(Boolean), inside: el.innerHTML };
}

describe('a card, a chat or a skill named in a message', () => {
  it('is drawn as the reference badge, with the name and the provider or skill mark', () => {
    render(<MarkdownBody mentions={MENTIONS}>{`See @bead:bw-1, @chat:${CHAT} and @skill:standup.`}</MarkdownBody>);
    expect(screen.getByTestId('mention-bead')).toHaveTextContent('bw-1');
    const chat = screen.getByTestId('mention-chat');
    expect(chat).toHaveTextContent('Standup notes');
    expect(chat.querySelector('svg[aria-label="Claude"]')).not.toBeNull();
    expect(screen.getByTestId('mention-skill')).toHaveTextContent('Standup');
    // The words around them are the writer's own.
    expect(document.body.textContent).toContain('See ');
    expect(document.body.textContent).not.toContain('@chat:');
  });

  it('draws the same badge in the composer as in the sent message', () => {
    for (const kind of ['bead', 'chat', 'skill'] as const) {
      const ref = describeRef(kind, kind === 'chat' ? CHAT : 'x-1');
      const { unmount } = render(<ReferenceBadge reference={ref} projectId="p1" testId="sent" />);
      const sent = face(screen.getByTestId('sent'));
      const drafted = face(referenceBadgeElement(ref));
      // The composer's badge adds only what a drawing of text needs.
      const extra = new Set(['mx-0.5', 'cursor-default', 'select-none']);
      expect(drafted.classes.filter((c) => !extra.has(c)).sort()).toEqual(
        sent.classes.filter((c) => drafted.classes.includes(c) || !isButtonClass(c)).sort(),
      );
      expect(drafted.inside).toBe(sent.inside);
      unmount();
    }
  });

  it('opens the chat it names in the chat’s own project', () => {
    render(<ReferenceBadge reference={describeRef('chat', CHAT)} projectId="p1" testId="sent" />);
    screen.getByTestId('sent').click();
    expect(push).toHaveBeenCalledWith(`/project?id=p2&tab=chat&chat=${CHAT}`);
  });

  it('stays words inside code', () => {
    render(<MarkdownBody mentions={MENTIONS}>{'Type `@bead:bw-1` to name one.'}</MarkdownBody>);
    expect(screen.queryByTestId('mention-bead')).toBeNull();
  });
});

/** What the `Button` inside a sent badge adds for being a control. */
function isButtonClass(c: string): boolean {
  return /^(cursor-pointer|group|focus-visible:|inline-flex|items-center|justify-center|has-data|ring-offset|transition|disabled:|\[&_svg\]|text-sm|font-medium|whitespace-nowrap)/.test(c);
}

describe('a card, a chat or a skill named in the composer', () => {
  async function aComposer(value: string) {
    const { ComposerEditor } = await import('@/workbench/composer-editor');
    const { EditorView } = await import('@codemirror/view');
    const { waitFor } = await import('@testing-library/react');
    const drawn = render(<ComposerEditor value={value} onChange={() => {}} onKey={() => false} onFiles={() => {}} describe={describeRef} />);
    const editor = await waitFor(() => EditorView.findFromDOM(drawn.container.querySelector('.cm-editor') as HTMLElement)!);
    return { ...drawn, editor };
  }

  const drawnIn = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-testid="composer-reference"][data-reference-kind]')].map(
      (b) => `${b.getAttribute('data-reference-kind')}:${b.textContent}`,
    );

  it('is drawn as its badge while the words underneath stay what was typed', async () => {
    const line = `Compare @bead:bw-1 with @chat:${CHAT} using @skill:standup please`;
    const { container, editor } = await aComposer(line);
    expect(drawnIn(container)).toEqual(['bead:bw-1', 'chat:Standup notes', 'skill:Standup']);
    expect(editor.state.doc.toString()).toBe(line);
  });

  it('is left as words while it is still being typed at the end of the line', async () => {
    const { container } = await aComposer('Look at @bead:bw-1');
    expect(drawnIn(container)).toEqual([]);
  });

  it('draws a skill command at the start as the same skill badge', async () => {
    const { container } = await aComposer('/skill:standup for today');
    expect(drawnIn(container)).toEqual(['skill:Standup']);
  });
});
