/**
 * Auto-approve: the app answering the cards itself.
 *
 * Some accounts cannot use the provider's own automatic modes: the setting is
 * refused, or the organisation removed it, and every tool call then waits on a
 * person pressing Yes. With auto-approve on, the provider keeps asking as its
 * mode says and this app presses the allow-once button.
 *
 * It used to be a permission mode of its own, so turning it on took the chat
 * out of plan mode. It is now a setting beside the mode (bw-q8ehk.1).
 *
 * What is proved here is the half the reader sees: the setting is its own
 * switch, and a card the app answered never reads as one he answered. The
 * server half — that the once-only option is the one pressed — is in
 * `server/src/workbench/answering.rs` and in the permission handler's own
 * tests (bw-0z25.1).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AutoApprovePicker } from '@/workbench/chat-tab';
import { asView, foldAll, reduce, EMPTY, type TranscriptAsk } from '@/workbench/fold';
import { PERMISSION_MODE } from '@/workbench/machine-words';
import { type AskOption, type WbpEvent } from '@/workbench/protocol';
import { PermissionCard } from '@/workbench/transcript-rows';

const sendCommand = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('@/workbench/use-session', async (real) => ({
  ...(await real<typeof import('@/workbench/use-session')>()),
  sendCommand,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

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

describe('auto-approve is its own setting, beside the permission mode', () => {
  const started = {
    type: 'session.started', sessionId: 'chat-1', seq: 1, at: '2026-10-27T00:00:00Z',
    brand: 'claude', externalId: null, model: null, cwd: '/p', permissionMode: 'plan', autoApprove: true,
  } as WbpEvent;
  const turnedOff = {
    type: 'session.pinned', sessionId: 'chat-1', seq: 2, at: '2026-10-27T00:00:01Z',
    permissionMode: null, model: null, autoApprove: false,
  } as WbpEvent;
  const modeOnly = {
    type: 'session.pinned', sessionId: 'chat-1', seq: 3, at: '2026-10-27T00:00:02Z',
    permissionMode: 'default', model: null,
  } as WbpEvent;

  it('is no longer one of the modes', () => {
    expect(PERMISSION_MODE.atelierAuto).toBeUndefined();
  });

  it('is on in plan mode, and changing one leaves the other alone, down both paths', () => {
    for (const fold of [(events: WbpEvent[]) => events.reduce(reduce, EMPTY), foldAll]) {
      const planned = fold([started]);
      expect(planned.permissionMode).toBe('plan');
      expect(planned.autoApprove).toBe(true);
      const moved = fold([started, modeOnly]);
      expect(moved.permissionMode).toBe('default');
      expect(moved.autoApprove).toBe(true);
      const off = fold([started, turnedOff]);
      expect(off.permissionMode).toBe('plan');
      expect(off.autoApprove).toBe(false);
    }
  });

  it('is sent as its own command, never as a mode', () => {
    render(<AutoApprovePicker sessionId="chat-1" on={false} asleep={false} defaultOn={false} onError={() => {}} />);
    const trigger = screen.getByTestId('auto-approve-picker');
    expect(trigger).toHaveAttribute('data-current', 'off');
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByText('Auto-approve on'));
    expect(sendCommand).toHaveBeenCalledWith({ type: 'session.auto-approve', sessionId: 'chat-1', on: true });
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
