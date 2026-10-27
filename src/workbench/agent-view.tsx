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

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { Clock, Coins, Gauge, X } from 'lucide-react';

import type { Mentions } from '@/components/markdown-body';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Overlay, overlayPanel } from '@/components/ui/overlay';
import { Panel } from '@/components/ui/panel';
import { Tooltip } from '@/components/ui/tooltip';
import { request } from '@/lib/api';
import { cn } from '@/lib/utils';
import { commandRun } from '@/workbench/command-run';
import { ComposerEditor, ComposerFrame, SendButton, type ComposerHandle } from '@/workbench/composer-editor';
import type { SentAway, TranscriptItem } from '@/workbench/fold';
import type { AgentControl } from '@/workbench/protocol';
// A finished shell's output is drawn with xterm, fetched when one is shown (bw-fbzd.4).
const RanTerminal = dynamic(() => import('@/workbench/ran-terminal').then((m) => m.RanTerminal), { ssr: false });
import { AgentSteering, effortNamed, forHowLong, isOver, KINDS, liveSeconds, modelNamed, spend, STATES, steerable, useNow } from '@/workbench/sent-away';
import { withPresented } from '@/workbench/presented';
import { InHelperPane, TranscriptRow } from '@/workbench/transcript-rows';
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
function RelayBox({ row, sessionId, typing }: { row: SentAway; sessionId: string; typing: RefObject<ComposerHandle> }) {
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

  // The chat's own box, frame and button, so the two places a reader writes
  // to an agent are one control and not two that look alike (composer-editor.tsx).
  return (
    <div className="border-t border-border/60 px-4 py-3" data-testid="agent-view-relay">
      {refused && (
        <Panel asChild tone="danger" className="mb-2 text-xs text-danger">
          <p data-testid="agent-view-relay-error">{refused}</p>
        </Panel>
      )}
      <ComposerFrame>
        <ComposerEditor
          ref={typing}
          testId="agent-view-relay-text"
          value={text}
          onChange={setText}
          onKey={(e) => {
            if (e.key !== 'Enter' || e.shiftKey) return false;
            send();
            return true;
          }}
          // Only words reach a helper: the chat passes them on as a sentence.
          onFiles={() => {}}
          placeholder="Message subagent"
          className="w-full leading-6"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">Sent through the main chat</span>
          <SendButton testId="agent-view-relay-send" disabled={sending || text.trim() === ''} onClick={send} />
        </div>
      </ComposerFrame>
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
  // A command has no conversation, and never had one. What it has is a
  // terminal, and this pane draws that instead: no transcript is read for it,
  // no older pages are fetched, and no box invites the reader to talk to a
  // shell (command-run.ts).
  const isShell = row.kind === 'command';
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
    return withPresented(merged);
  }, [history, historyReady, live]);

  useEffect(() => {
    if (isShell) return;
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
  }, [isShell, sentBy, sessionId]);

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
  const effort = effortNamed(row.effort);
  // The row's own clock, not the kit's raw count: the row that was clicked is
  // counting live between the kit's reports, and a pane that answered `0s`
  // beside a row reading `2s` is two accounts of one agent (measured 2026-08-20).
  const now = useNow(!isOver(row.state));
  const shell = isShell ? commandRun(row, items, liveSeconds(row, now)) : null;
  const relaying = !isShell && !isOver(row.state) && controls.includes('say');
  const sheet = useRef<HTMLDivElement>(null);
  const typing = useRef<ComposerHandle>(null);

  return (
    <Overlay
      testId="agent-view"
      label={row.what || KINDS[row.kind].label}
      data-agent={row.id}
      data-said={said.length}
      onClose={onClose}
      // Into the message box when there is one, and onto the pane itself when
      // not. Left to the dialog, focus went to Background, the first button,
      // which then wore its ring and showed its tooltip on every opening.
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        if (typing.current) typing.current.focus();
        else sheet.current?.focus();
      }}
    >
      {/* One shape every time it is opened, and only the conversation inside it
          moves. Sized to its content, a pane opened on a helper that has said one
          line is a toast, and it grows under the reader as the helper talks.
          A shell is the exception: its terminal is a fixed number of lines, so
          it is already one shape, and stretching the pane past it left half
          the screen empty under the grid. */}
      <Panel
        ref={sheet}
        tabIndex={-1}
        tone="overlay"
        inset="none"
        className={cn(overlayPanel, 'max-w-4xl outline-none', !isShell && 'sm:h-[85vh]')}
      >
        <header className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            {/* What it is, what it was asked, then where it stands: the same
                three things the row says, in the same order, top to bottom. */}
            <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <span data-testid="agent-view-kind">{kind}</span>
              {row.agentType && row.agentType !== kind && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="truncate normal-case tracking-normal" data-testid="agent-view-agent-type">{row.agentType}</span>
                </>
              )}
            </div>
            <Tooltip label={row.what || kind}>
              <h2
                className={cn('truncate text-sm font-semibold text-foreground', isShell && 'font-mono')}
                data-testid="agent-view-what"
              >
                {row.what || kind}
              </h2>
            </Tooltip>
            {/* The same numbers the row carries, off the same clock, so opening
                one is not a different account of it from the one that was
                clicked — and none of them for a shell, which has no model,
                spent nothing, and keeps its own clock in the terminal's footer
                a few pixels below (bw-sb5g.3). */}
            <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
              <Badge variant={state.variant} appearance="light" size="xs" data-testid="agent-view-state">
                {state.label}
              </Badge>
              {!isShell && model && (
                <Tooltip label={row.model ?? undefined}>
                  <span data-testid="agent-view-model">{model}</span>
                </Tooltip>
              )}
              {!isShell && effort && (
                <Tooltip label={`Reasoning effort — ${effort}`}>
                  <span className="flex items-center gap-1" data-testid="agent-view-effort">
                    <Gauge className="h-3 w-3" aria-hidden="true" />
                    {effort}
                  </span>
                </Tooltip>
              )}
              {!isShell && (
                <span className="flex items-center gap-1" data-testid="agent-view-for">
                  <Clock className="h-3 w-3" aria-hidden="true" />
                  {forHowLong(liveSeconds(row, now))}
                </span>
              )}
              {!isShell && (
                <Tooltip label={`${row.tokens.toLocaleString()} tokens over ${row.calls} call${row.calls === 1 ? '' : 's'}`}>
                  <span className="flex items-center gap-1" data-testid="agent-view-spend">
                    <Coins className="h-3 w-3" aria-hidden="true" />
                    {spend(row.tokens)}
                  </span>
                </Tooltip>
              )}
            </div>
          </div>
          <AgentSteering row={row} sessionId={sessionId} controls={controls} placement="header" />
          {steerable(row, controls) && (
            <span aria-hidden="true" className="h-5 w-px shrink-0 bg-border" />
          )}
          <Button size="sm" mode="icon" variant="ghost" data-testid="agent-view-close" aria-label="Close" onClick={onClose}>
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </header>

        {shell ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-4" data-testid="agent-view-shell">
            <RanTerminal run={shell.run} outcome={shell.outcome} rows={24} />
          </div>
        ) : (
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
            <InHelperPane.Provider value={true}>
              {said.map((item) => (
                <TranscriptRow key={item.id} item={item} sessionId={sessionId} mentions={mentions} onLook={() => {}} />
              ))}
            </InHelperPane.Provider>
          </div>
        )}

        {/* Words the reader typed FOR it, and where they actually went. Drawn
            as relayed, never as said to it: it never heard them. */}
        {row.relayed.length > 0 && (
          <div className="border-t border-border/60 px-4 py-3" data-testid="agent-view-relayed" data-count={row.relayed.length}>
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Your messages
            </h3>
            {row.relayed.map((said, i) => (
              <p key={i} className="mt-1 whitespace-pre-wrap text-xs text-foreground">
                {said}
              </p>
            ))}
          </div>
        )}

        {/* Not for a shell. Nothing this app could send would reach a running
            command's stdin, and a box captioned "Message subagent" under a
            terminal is an offer it cannot keep. Stopping it still can, and
            that control is in the header where it always was. */}
        {relaying && <RelayBox row={row} sessionId={sessionId} typing={typing} />}

        {/* Its answer, kept where a reader who opened this to find it looks:
            at the end of what it said, not scrolled back into the chat. Never
            for a shell: what a command "answered" is its own output, which the
            grid above already holds in full (bw-sb5g.3). */}
        {row.result && !isShell && (
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
