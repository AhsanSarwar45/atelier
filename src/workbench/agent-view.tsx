/**
 * One sent-off agent's own conversation, opened from its row
 * (docs/agent-workbench.md §8.2.7).
 *
 * Nothing here is fetched and nothing is remembered. Every event a sent-off
 * agent produced already arrives carrying the call that sent it, and both ways
 * of building a conversation keep that on the row — so an agent's conversation
 * is the chat's own conversation, read by who said it. That is also why it is
 * still there tomorrow: the sidecar replays its own log and the parentage is
 * rebuilt with everything else, rather than depending on this browser having
 * been watching at the time.
 *
 * It opens over the conversation rather than inside the column it was clicked
 * in. The column is 288px because it holds chips; a conversation read at that
 * width is a column of two words per line.
 *
 * The chat's own kind switches are deliberately not applied. A reader who has
 * turned commands off in the conversation has turned them off in the
 * conversation; this pane is opened to see everything one agent did, and a
 * pane that silently hid half of it would be worse than no pane.
 */
'use client';

import { useEffect, useMemo, useState } from 'react';

import { Clock, Coins, Send, X } from 'lucide-react';

import type { Mentions } from '@/components/markdown-body';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { Textarea } from '@/components/ui/textarea';
import type { SentAway, TranscriptItem } from '@/workbench/fold';
import type { AgentControl } from '@/workbench/protocol';
import { AgentSteering, forHowLong, isOver, KINDS, liveSeconds, modelNamed, spend, STATES, useNow } from '@/workbench/sent-away';
import { TranscriptRow } from '@/workbench/transcript-rows';
import { sendCommand } from '@/workbench/use-session';

/**
 * Everything one sent-off agent said, in the order it said it.
 *
 * By the CALL that sent it, never by the agent's own id: the kit gives a helper
 * an id of its own and stamps everything the helper says with the call instead,
 * and the two are different strings. Read by the agent's id, the pane opened on
 * an empty conversation every time — measured 2026-08-20, against a real chat.
 *
 * A permission question a helper raised reaches here on the same terms as its
 * words: the kit names the call being asked about, that call is on record as
 * the helper's own, and the question is stamped with the call that sent the
 * helper (bw-7ks.22.5). So it is answered on the helper's own conversation,
 * where the reader can see what it was for.
 */
export function saidBy(items: TranscriptItem[], row: Pick<SentAway, 'id' | 'toolCallId'>): TranscriptItem[] {
  const sentBy = row.toolCallId ?? row.id;
  return items.filter((item) => 'parentId' in item && item.parentId === sentBy);
}

/**
 * The third tier of steering, and the honest one (docs/agent-workbench.md
 * §8.2.7).
 *
 * Neither brand gives anyone a private input channel into a helper that is
 * already running, so this does not pretend to be one: what is typed goes to
 * the CHAT that sent the agent, naming which agent it is for, and the pane says
 * so both before it is sent and after. A word drawn as delivered would be a lie
 * about the road it took.
 *
 * A word that never left says so, and stays in the box. Clearing the box is how
 * this pane says the words went; clearing it on a refusal would be the same lie
 * with the evidence thrown away (bw-7ks.22.34).
 */
function RelayBox({ row, sessionId }: { row: SentAway; sessionId: string }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  const send = (): void => {
    const said = text.trim();
    if (!said || sending) return;
    setSending(true);
    setRefused(null);
    void sendCommand({ type: 'agent.say', sessionId, agentId: row.id, text: said })
      .then(() => setText(''))
      .catch((e: unknown) => setRefused(`Not sent. ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setSending(false));
  };

  return (
    <div className="border-t border-border/60 px-4 py-3" data-testid="agent-view-relay">
      <p className="text-[11px] text-muted-foreground">
        Nothing can hand words to an agent that is already running. What you type goes to the chat that sent this
        one, naming it.
      </p>
      <div className="mt-2 flex items-end gap-2">
        <Textarea
          rows={2}
          value={text}
          data-testid="agent-view-relay-text"
          placeholder="A word for this agent, by way of the chat that sent it"
          className="min-h-0 flex-1 resize-none text-xs"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <Button
          size="sm"
          data-testid="agent-view-relay-send"
          disabled={sending || text.trim() === ''}
          onClick={send}
        >
          <Send className="h-3.5 w-3.5" aria-hidden="true" />
          Relay
        </Button>
      </div>
      {refused && (
        <p data-testid="agent-view-relay-error" className="mt-2 text-[11px] text-red-500">
          {refused}
        </p>
      )}
    </div>
  );
}

export interface AgentViewProps {
  row: SentAway;
  /** The whole conversation; what belongs to this agent is picked out here. */
  items: TranscriptItem[];
  sessionId: string;
  /** Which steering controls this chat's brand has. None is a real answer. */
  controls: AgentControl[];
  mentions: Mentions;
  onClose: () => void;
}

export function AgentView({ row, items, sessionId, controls, mentions, onClose }: AgentViewProps) {
  const said = useMemo(() => saidBy(items, row), [items, row]);
  const { label: kind, Icon } = KINDS[row.kind];
  const state = STATES[row.state];
  const model = modelNamed(row.model);
  // The row's own clock, not the kit's raw count: the row that was clicked is
  // counting live between the kit's reports, and a pane that answered `0s`
  // beside a row reading `2s` is two accounts of one agent (measured 2026-08-20).
  const now = useNow(!isOver(row.state));

  // The way out a reader tries first on anything that opened over what they
  // were reading.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-8"
      data-testid="agent-view"
      data-agent={row.id}
      data-said={said.length}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* One shape every time it is opened, and only the conversation inside it
          moves. Sized to its content, a pane opened on a helper that has said one
          line is a toast, and it grows under the reader as the helper talks. */}
      <Panel tone="overlay" inset="none" className="flex h-[85vh] max-h-full w-full max-w-4xl flex-col">
        <div className="flex items-start gap-2 border-b border-border/60 px-4 py-3">
          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-foreground" data-testid="agent-view-what">
              {row.what || kind}
            </h2>
            {/* The same three numbers the row carries, off the same clock, so
                opening one is not a different account of it from the one that
                was clicked. */}
            <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
              {model && (
                <span data-testid="agent-view-model" title={row.model ?? undefined}>
                  {model}
                </span>
              )}
              <span className="flex items-center gap-1" data-testid="agent-view-for">
                <Clock className="h-3 w-3" aria-hidden="true" />
                {forHowLong(liveSeconds(row, now))}
              </span>
              <span
                className="flex items-center gap-1"
                data-testid="agent-view-spend"
                title={`${row.tokens.toLocaleString()} tokens over ${row.calls} call${row.calls === 1 ? '' : 's'}`}
              >
                <Coins className="h-3 w-3" aria-hidden="true" />
                {spend(row.tokens)}
              </span>
            </div>
          </div>
          <AgentSteering row={row} sessionId={sessionId} controls={controls} />
          <Badge variant={state.variant} appearance="light" size="xs" data-testid="agent-view-state">
            {state.label}
          </Badge>
          <Button size="xs" variant="ghost" data-testid="agent-view-close" aria-label="Close" onClick={onClose}>
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4" data-testid="agent-view-said">
          {said.map((item) => (
            <TranscriptRow key={item.id} item={item} sessionId={sessionId} mentions={mentions} onLook={() => {}} />
          ))}
          {said.length === 0 && (
            <p className="text-xs text-muted-foreground" data-testid="agent-view-nothing">
              {isOver(row.state)
                ? 'This one said nothing of its own — only what it answered, below.'
                : 'Nothing said yet. Its own words draw here as they arrive.'}
            </p>
          )}
        </div>

        {/* Words the reader typed FOR it, and where they actually went. Drawn
            as relayed, never as said to it: it never heard them. */}
        {row.relayed.length > 0 && (
          <div className="border-t border-border/60 px-4 py-3" data-testid="agent-view-relayed" data-count={row.relayed.length}>
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Relayed to the chat that sent it
            </h3>
            {row.relayed.map((said, i) => (
              <p key={i} className="mt-1 whitespace-pre-wrap text-xs text-foreground">
                {said}
              </p>
            ))}
          </div>
        )}

        {!isOver(row.state) && controls.includes('say') && <RelayBox row={row} sessionId={sessionId} />}

        {/* Its answer, kept where a reader who opened this to find it looks:
            at the end of what it said, not scrolled back into the chat. */}
        {row.result && (
          <div className="border-t border-border/60 px-4 py-3">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">What it answered</h3>
            <p className="mt-1 whitespace-pre-wrap text-xs text-foreground" data-testid="agent-view-result">
              {row.result}
            </p>
          </div>
        )}
      </Panel>
    </div>
  );
}
