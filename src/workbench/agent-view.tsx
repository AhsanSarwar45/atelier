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

import { useEffect, useMemo } from 'react';

import { Clock, Coins, X } from 'lucide-react';

import type { Mentions } from '@/components/markdown-body';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import type { SentAway, TranscriptItem } from '@/workbench/fold';
import { forHowLong, isOver, KINDS, liveSeconds, modelNamed, spend, STATES, useNow } from '@/workbench/sent-away';
import { TranscriptRow } from '@/workbench/transcript-rows';

/**
 * Everything one sent-off agent said, in the order it said it.
 *
 * By the CALL that sent it, never by the agent's own id: the kit gives a helper
 * an id of its own and stamps everything the helper says with the call instead,
 * and the two are different strings. Read by the agent's id, the pane opened on
 * an empty conversation every time — measured 2026-08-20, against a real chat.
 *
 * A permission question is the one row that carries no parent yet — the kit
 * does not say which agent raised it — so none of them reach here. That is a
 * known gap on the job rather than an oversight.
 */
export function saidBy(items: TranscriptItem[], row: Pick<SentAway, 'id' | 'toolCallId'>): TranscriptItem[] {
  const sentBy = row.toolCallId ?? row.id;
  return items.filter((item) => 'parentId' in item && item.parentId === sentBy);
}

export interface AgentViewProps {
  row: SentAway;
  /** The whole conversation; what belongs to this agent is picked out here. */
  items: TranscriptItem[];
  sessionId: string;
  mentions: Mentions;
  onClose: () => void;
}

export function AgentView({ row, items, sessionId, mentions, onClose }: AgentViewProps) {
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
