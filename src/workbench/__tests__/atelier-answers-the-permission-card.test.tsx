/**
 * The permission mode in which the app answers the cards.
 *
 * Some accounts cannot use the provider's own automatic modes: the setting is
 * refused, or the organisation removed it, and every tool call then waits on a
 * person pressing Yes. "Atelier automatic" leaves the provider asking exactly
 * as it would when asking first, and this app presses the allow-once button.
 *
 * What is proved here is the half the reader sees: the mode is offered, and a
 * card the app answered never reads as one he answered. The server half — that
 * the provider is left in a mode that still asks, and that the once-only
 * option is the one pressed — is in `server/src/workbench/answering.rs` and in
 * the permission handler's own tests (bw-0z25.1).
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { asView, foldAll, reduce, EMPTY, type TranscriptAsk } from '@/workbench/fold';
import { PERMISSION_MODE } from '@/workbench/machine-words';
import { ATELIER_AUTO, type AskOption, type WbpEvent } from '@/workbench/protocol';
import { PermissionCard } from '@/workbench/transcript-rows';

vi.mock('@/workbench/commands', () => ({ sendCommand: vi.fn(async () => ({})) }));

/** Copied from what claude-acp sends on a live turn (bw-t26l.20). */
const AS_CLAUDE_SENDS_THEM: AskOption[] = [
  { id: 'allow-once', label: 'Yes', kind: 'allow_once' },
  { id: 'allow-with-updates', label: 'Yes, allow all edits during this session', kind: 'allow_always' },
  { id: 'reject', label: 'No', kind: 'reject_once' },
];

const asked: WbpEvent = {
  type: 'ask.permission',
  sessionId: 'chat-1',
  askId: 'ask-1',
  toolName: 'Edit notes.txt',
  title: 'Edit notes.txt',
  options: AS_CLAUDE_SENDS_THEM,
} as WbpEvent;

const answeredByTheApp: WbpEvent = {
  type: 'ask.resolved',
  sessionId: 'chat-1',
  askId: 'ask-1',
  chosen: 'allow-once',
  by: 'atelier',
} as WbpEvent;

const onlyAsk = (view: { items: readonly { kind: string }[] }) =>
  view.items.find((item) => item.kind === 'ask') as TranscriptAsk;

describe('the mode is offered wherever the provider’s modes are', () => {
  it('names it in words, not in its wire spelling', () => {
    // The picker is where a chat's owner finds out whether it will stop to ask
    // him. `atelierAuto` is not a sentence anyone should have to read (§8.2.4).
    expect(PERMISSION_MODE[ATELIER_AUTO].label).toBe('Atelier automatic');
  });
});

describe('a card the app answered', () => {
  it('says the app approved it, and never that he did', () => {
    render(
      <PermissionCard
        sessionId="chat-1"
        askId="ask-1"
        title="Edit notes.txt"
        toolName="Edit notes.txt"
        options={AS_CLAUDE_SENDS_THEM}
        chosen="allow-once"
        chosenBy="atelier"
      />,
    );
    const resolved = screen.getByTestId('permission-resolved');
    expect(resolved).toHaveTextContent('Approved automatically');
    expect(resolved.textContent).not.toContain('Allowed');
  });

  it('still reads as his own when he was the one who pressed it', () => {
    render(
      <PermissionCard
        sessionId="chat-1"
        askId="ask-1"
        title="Edit notes.txt"
        toolName="Edit notes.txt"
        options={AS_CLAUDE_SENDS_THEM}
        chosen="allow-once"
      />,
    );
    expect(screen.getByTestId('permission-resolved')).toHaveTextContent('Allowed');
  });

  it('carries who answered through a chat watched as it happens', () => {
    const view = [asked, answeredByTheApp].reduce(reduce, EMPTY);
    expect(onlyAsk(view).chosen).toBe('allow-once');
    expect(onlyAsk(view).chosenBy).toBe('atelier');
  });

  it('carries it through a chat opened after the fact', () => {
    // The transcript is rebuilt from the record on every reload, down a second
    // path. A mark that survived only the live fold would vanish on refresh,
    // and the same card would then read as his (bw-0z25.1).
    const view = foldAll([asked, answeredByTheApp]);
    expect(onlyAsk(view).chosenBy).toBe('atelier');
  });

  it('carries it through the snapshot a reopened chat is actually drawn from', () => {
    // A chat is not reopened by replaying its events in the browser: the server
    // folds them and sends the finished transcript, and `asView` is what the
    // screen opens on. The mark has to survive that crossing too, which is
    // where it was being dropped (`projection.rs`, bw-0z25.1).
    const view = asView({
      items: [
        {
          kind: 'ask',
          id: 'ask-1',
          toolName: 'Edit notes.txt',
          title: 'Edit notes.txt',
          options: AS_CLAUDE_SENDS_THEM,
          chosen: 'allow-once',
          chosenBy: 'atelier',
        } as TranscriptAsk,
      ],
    });
    expect(onlyAsk(view).chosenBy).toBe('atelier');
  });

  it('leaves a card he answered himself unmarked down both paths', () => {
    const byHim = { ...answeredByTheApp, by: undefined } as WbpEvent;
    expect(onlyAsk([asked, byHim].reduce(reduce, EMPTY)).chosenBy).toBeUndefined();
    expect(onlyAsk(foldAll([asked, byHim])).chosenBy).toBeUndefined();
  });
});
