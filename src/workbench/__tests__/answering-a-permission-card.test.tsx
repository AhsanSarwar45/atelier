/**
 * A permission card, drawn from what a real ACP agent actually sends.
 *
 * Every option on a card carries two words for itself: an id and a label, both
 * in the agent's own vocabulary, and a kind, which is the protocol's and reads
 * the same for every agent. The card used to ask about neither — it compared
 * the id, and the label, against the word "deny", which is a word ACP does not
 * use for a refusal. So on a live card the No button was drawn as emphatically
 * as the Yes beside it, and pressing it left the card saying "Allowed" for a
 * tool the person had just refused (bw-t26l.20).
 *
 * The options here are copied verbatim from what claude-acp sent on a live turn
 * (tests/.e2e-run-s9495-live2): ids "allow-once" / "allow-with-updates" /
 * "reject", kinds allow_once / allow_always / reject_once, labels "Yes" /
 * "Yes, allow all edits during this session" / "No".
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { NOBODY_ANSWERED, type AskOption } from '@/workbench/protocol';
import { PermissionCard } from '@/workbench/transcript-rows';

vi.mock('@/workbench/commands', () => ({ sendCommand: vi.fn(async () => ({})) }));

const AS_CLAUDE_SENDS_THEM: AskOption[] = [
  { id: 'allow-once', label: 'Yes', kind: 'allow_once' },
  { id: 'allow-with-updates', label: 'Yes, allow all edits during this session', kind: 'allow_always' },
  { id: 'reject', label: 'No', kind: 'reject_once' },
];

const card = (chosen: string | null) => (
  <PermissionCard
    sessionId="chat-1"
    askId="ask-1"
    title="Edit notes.txt"
    toolName="Edit notes.txt"
    options={AS_CLAUDE_SENDS_THEM}
    chosen={chosen}
  />
);

describe('a permission card from a live agent', () => {
  it('offers the agent’s own words on the buttons, and the protocol’s kind beside them', () => {
    render(card(null));
    const buttons = AS_CLAUDE_SENDS_THEM.map((o) => screen.getByTestId(`permission-${o.id}`));
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Yes',
      'Yes, allow all edits during this session',
      'No',
    ]);
    // The one thing that reads the same whoever is asking, so that a reader —
    // a person, a test, another program — can find the refusal without knowing
    // this agent's vocabulary.
    expect(buttons.map((b) => b.getAttribute('data-ask-kind'))).toEqual([
      'allow_once',
      'allow_always',
      'reject_once',
    ]);
  });

  it('draws the refusal as the quiet one, not as another yes', () => {
    render(card(null));
    const no = screen.getByTestId('permission-reject');
    const yes = screen.getByTestId('permission-allow-once');
    expect(no.className).not.toEqual(yes.className);
  });

  it('says the request was refused when it was refused', () => {
    render(card('reject'));
    expect(screen.getByTestId('permission-resolved')).toHaveTextContent('Denied');
  });

  it('says the request was allowed when it was allowed', () => {
    render(card('allow-with-updates'));
    expect(screen.getByTestId('permission-resolved')).toHaveTextContent('Allowed');
  });

  it('says the turn was stopped when nobody answered it', () => {
    // Stopping a turn closes every card still open, and the server marks them
    // with NOBODY_ANSWERED because no option was pressed. That word matches
    // none of the agent's ids, so the card fell through to its allow_once
    // fallback and told the reader he had ALLOWED a tool he never answered
    // (bw-t26l.20).
    render(card(NOBODY_ANSWERED));
    expect(screen.getByTestId('permission-resolved')).toHaveTextContent('Stopped');
  });

  it('asks once, rather than asking and then repeating itself underneath', () => {
    // ACP sends one human sentence for the call, and it arrives as both the
    // name and the detail. Printing both put "Edit notes.txt" on the card twice.
    render(card(null));
    expect(screen.queryAllByText('Edit notes.txt')).toHaveLength(0);
    expect(screen.getByText('Allow Edit notes.txt?')).toBeInTheDocument();
  });
});
