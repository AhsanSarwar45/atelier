/**
 * One sent-off agent's own conversation, opened from its row
 * (docs/agent-workbench.md §8.2.7).
 *
 * Every event a sent-off agent produced carries the call that sent it. The
 * newest bounded page is read by that canonical parent, older pages are fetched
 * only at the top, and live rows still arrive through the parent chat stream.
 * No provider has a private transcript implementation and nothing depends on
 * this browser having watched the helper at the time.
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Clock, Coins, Send, X } from 'lucide-react';

import type { Mentions } from '@/components/markdown-body';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Overlay, overlayPanel } from '@/components/ui/overlay';
import { Panel } from '@/components/ui/panel';
import { Textarea } from '@/components/ui/textarea';
import { request } from '@/lib/api';
import { cn } from '@/lib/utils';
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
      <div className="flex items-end gap-2">
        <Textarea
          rows={2}
          value={text}
          data-testid="agent-view-relay-text"
          placeholder="Message subagent"
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
          Send
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
  const sentBy = row.toolCallId ?? row.id;
  const live = useMemo(() => saidBy(items, row), [items, row]);
  const [history, setHistory] = useState<TranscriptItem[]>(live);
  const [historyReady, setHistoryReady] = useState(false);
  const [cursor, setCursor] = useState<number | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const requestGeneration = useRef(0);
  const loadingOlderRef = useRef(false);
  const liveRef = useRef(live);
  const openingKeys = useRef(new Set(live.map((item) => `${item.kind}:${item.id}`)));
  liveRef.current = live;
  const said = useMemo(() => {
    const newest = new Map(live.map((item) => [`${item.kind}:${item.id}`, item]));
    const merged = history.map((item) => newest.get(`${item.kind}:${item.id}`) ?? item);
    const known = new Set(merged.map((item) => `${item.kind}:${item.id}`));
    for (const item of live) {
      const key = `${item.kind}:${item.id}`;
      if (!known.has(key) && (!historyReady || !openingKeys.current.has(key))) merged.push(item);
    }
    return merged;
  }, [history, historyReady, live]);

  useEffect(() => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    openingKeys.current = new Set(liveRef.current.map((item) => `${item.kind}:${item.id}`));
    loadingOlderRef.current = false;
    setHistory(liveRef.current);
    setHistoryReady(false);
    setCursor(null);
    setHasOlder(false);
    setHistoryError(null);
    void (async () => {
      try {
        const res = await request(`/api/workbench/history?session=${encodeURIComponent(sessionId)}&parent=${encodeURIComponent(sentBy)}`);
        if (!res.ok) throw new Error(`history failed: ${res.status}`);
        const page = (await res.json()) as Partial<{ items: TranscriptItem[]; cursor: number | null; hasOlder: boolean }>;
        if (!Array.isArray(page.items)) throw new Error('history returned no transcript items');
        if (requestGeneration.current !== generation) return;
        setHistory(page.items);
        setHistoryReady(true);
        setCursor(page.cursor ?? null);
        setHasOlder(page.hasOlder === true && page.cursor != null);
      } catch (error) {
        if (requestGeneration.current === generation) {
          setHistoryError(error instanceof Error ? error.message : String(error));
        }
      }
    })();
    return () => {
      if (requestGeneration.current === generation) requestGeneration.current += 1;
    };
  }, [sentBy, sessionId]);

  const loadOlder = useCallback(async (): Promise<void> => {
    if (loadingOlderRef.current || !hasOlder || cursor === null) return;
    loadingOlderRef.current = true;
    const generation = requestGeneration.current;
    setLoadingOlder(true);
    setHistoryError(null);
    const pane = historyRef.current;
    const previousHeight = pane?.scrollHeight ?? 0;
    const previousTop = pane?.scrollTop ?? 0;
    try {
      const res = await request(`/api/workbench/history?session=${encodeURIComponent(sessionId)}&parent=${encodeURIComponent(sentBy)}&before=${cursor}`);
      if (!res.ok) throw new Error(`history failed: ${res.status}`);
      const page = (await res.json()) as Partial<{ items: TranscriptItem[]; cursor: number | null; hasOlder: boolean }>;
      if (!Array.isArray(page.items)) throw new Error('history returned no transcript items');
      if (requestGeneration.current !== generation) return;
      const olderItems = page.items;
      setHistory((current) => {
        const known = new Set(current.map((item) => `${item.kind}:${item.id}`));
        return [...olderItems.filter((item) => !known.has(`${item.kind}:${item.id}`)), ...current];
      });
      setCursor(page.cursor ?? null);
      setHasOlder(page.hasOlder === true && page.cursor != null && page.cursor !== cursor);
      const restore = (): void => {
        if (pane) pane.scrollTop = previousTop + pane.scrollHeight - previousHeight;
      };
      // Keep the in-flight latch through the measured prepend correction.
      // Releasing it before this frame lets the browser's correction scroll
      // synchronously enter `onScroll` at zero and request the next page from
      // the same human gesture.
      if (typeof requestAnimationFrame === 'function') {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            restore();
            resolve();
          });
        });
      } else {
        restore();
      }
    } catch (error) {
      if (requestGeneration.current === generation) {
        setHistoryError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      loadingOlderRef.current = false;
      if (requestGeneration.current === generation) setLoadingOlder(false);
    }
  }, [cursor, hasOlder, sentBy, sessionId]);
  const { label: kind, Icon } = KINDS[row.kind];
  const state = STATES[row.state];
  const model = modelNamed(row.model);
  // The row's own clock, not the kit's raw count: the row that was clicked is
  // counting live between the kit's reports, and a pane that answered `0s`
  // beside a row reading `2s` is two accounts of one agent (measured 2026-08-20).
  const now = useNow(!isOver(row.state));

  return (
    <Overlay
      testId="agent-view"
      label={row.what || KINDS[row.kind].label}
      data-agent={row.id}
      data-said={said.length}
      onClose={onClose}
    >
      {/* One shape every time it is opened, and only the conversation inside it
          moves. Sized to its content, a pane opened on a helper that has said one
          line is a toast, and it grows under the reader as the helper talks. */}
      <Panel tone="overlay" inset="none" className={cn(overlayPanel, 'max-w-4xl sm:h-[85vh]')}>
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

        <div
          ref={historyRef}
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 [overflow-anchor:none]"
          data-testid="agent-view-said"
          data-can-load-older={hasOlder}
          onScroll={(event) => {
            if (event.currentTarget.scrollTop <= 32) void loadOlder();
          }}
        >
          {loadingOlder && <div className="text-center text-[11px] text-muted-foreground" data-testid="agent-view-older-loading">Loading older messages…</div>}
          {historyError && <div className="text-center text-[11px] text-red-500" data-testid="agent-view-history-error">{historyError}</div>}
          {said.map((item) => (
            <TranscriptRow key={item.id} item={item} sessionId={sessionId} mentions={mentions} onLook={() => {}} />
          ))}
        </div>

        {/* Words the reader typed FOR it, and where they actually went. Drawn
            as relayed, never as said to it: it never heard them. */}
        {row.relayed.length > 0 && (
          <div className="border-t border-border/60 px-4 py-3" data-testid="agent-view-relayed" data-count={row.relayed.length}>
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Messages
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
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Result</h3>
            <p className="mt-1 whitespace-pre-wrap text-xs text-foreground" data-testid="agent-view-result">
              {row.result}
            </p>
          </div>
        )}
      </Panel>
    </Overlay>
  );
}
