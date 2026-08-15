/**
 * The Chat tab: the transcript, the composer, the Stop button and the
 * permission card.
 *
 * Design: docs/agent-workbench.md §8.2. This is work item 1's slice of it —
 * diffs, images, todos, subagents and the sidebar arrive with their own items.
 */
'use client';

import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { AskOption, Cost } from '@/workbench/protocol';
import {
  isBusy,
  sendCommand,
  useSession,
  useStartSession,
  type TranscriptItem,
} from '@/workbench/use-session';

interface ChatTabProps {
  projectId: string | null;
  projectPath: string | null;
}

function costLabel(cost: Cost): string {
  return cost.kind === 'usd'
    ? `$${cost.usd.toFixed(4)}`
    : `${cost.total.toLocaleString()} tokens`;
}

/** One permission card. Collapses to its answer once the human has clicked. */
function PermissionCard({
  sessionId,
  askId,
  title,
  toolName,
  options,
  chosen,
}: {
  sessionId: string;
  askId: string;
  title: string;
  toolName: string;
  options: AskOption[];
  chosen: string | null;
}) {
  const [pending, setPending] = useState<string | null>(null);

  if (chosen) {
    const answered = chosen === 'deny' ? 'Denied' : 'Allowed';
    return (
      <div
        data-testid="permission-card"
        data-ask-state="resolved"
        data-ask-id={askId}
        data-tool-name={toolName}
        className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
      >
        <span data-testid="permission-resolved" className="font-medium text-foreground">
          {answered}
        </span>
        {' · '}
        {title}
      </div>
    );
  }

  return (
    <div
      data-testid="permission-card"
      data-ask-state="open"
      data-ask-id={askId}
      data-tool-name={toolName}
      className="rounded-md border border-amber-500/60 bg-amber-500/10 px-3 py-3"
    >
      <div className="text-sm font-medium text-foreground">Allow {toolName}?</div>
      <div className="mt-0.5 break-all font-mono text-xs text-muted-foreground">{title}</div>
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((o) => (
          <Button
            key={o.id}
            size="sm"
            variant={o.kind === 'deny' ? 'outline' : o.kind === 'allow_always' ? 'secondary' : 'primary'}
            disabled={pending !== null}
            data-testid={`permission-${o.id}`}
            onClick={() => {
              setPending(o.id);
              void sendCommand({ type: 'ask.answer', sessionId, askId, optionId: o.id }).catch(() =>
                setPending(null),
              );
            }}
          >
            {o.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function ToolRow({ item }: { item: Extract<TranscriptItem, { kind: 'tool' }> }) {
  const dot =
    item.status === 'running' ? 'bg-amber-400 animate-pulse' : item.status === 'ok' ? 'bg-emerald-500' : 'bg-red-500';
  return (
    <div
      data-testid="tool-row"
      data-tool-status={item.status}
      data-tool-name={item.name}
      className="flex items-center gap-2 rounded border border-border/40 bg-muted/20 px-2.5 py-1.5 font-mono text-xs text-muted-foreground"
    >
      <span className={cn('h-2 w-2 shrink-0 rounded-full', dot)} />
      <span className="truncate">{item.title}</span>
      <span className="ml-auto shrink-0 uppercase tracking-wide">{item.status}</span>
    </div>
  );
}

export default function ChatTab({ projectId, projectPath }: ChatTabProps) {
  const { sessionId, start, starting, error: startError } = useStartSession(projectId, projectPath);
  const view = useSession(sessionId);
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [view.items]);

  const busy = isBusy(view.state);

  async function submit() {
    const text = draft.trim();
    if (!text || !sessionId) return;
    setDraft('');
    await sendCommand({ type: 'prompt.send', sessionId, text });
  }

  if (!projectId || !projectPath) {
    return <div className="p-8 text-muted-foreground">Pick a project to start a chat.</div>;
  }

  if (!sessionId) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24">
        <p className="text-muted-foreground">No chat open for this project.</p>
        <Button variant="primary" onClick={() => void start()} disabled={starting} data-testid="new-chat">
          {starting ? 'Starting…' : 'New chat'}
        </Button>
        {startError && <p className="max-w-lg text-center text-sm text-red-500">{startError}</p>}
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-6rem)] flex-col" data-testid="chat-tab" data-session-id={sessionId}>
      <div className="flex items-center gap-3 border-b border-border/60 px-4 py-2 text-sm">
        <span
          data-testid="session-state"
          data-state={view.state}
          className={cn('rounded-full px-2 py-0.5 text-xs font-medium', busy ? 'bg-amber-500/20 text-amber-200' : 'bg-muted text-muted-foreground')}
        >
          {view.stateLabel}
        </span>
        <span className="text-xs text-muted-foreground">claude · permission mode: default</span>
        {view.cost && (
          <span data-testid="cost-chip" className="ml-auto rounded bg-muted px-2 py-0.5 font-mono text-xs">
            {costLabel(view.cost)}
          </span>
        )}
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4" data-testid="transcript">
        {view.items.map((item) => {
          if (item.kind === 'tool') return <ToolRow key={item.id} item={item} />;
          if (item.kind === 'ask') {
            return (
              <PermissionCard
                key={item.id}
                sessionId={sessionId}
                askId={item.id}
                title={item.title}
                toolName={item.toolName}
                options={item.options}
                chosen={item.chosen}
              />
            );
          }
          return (
            <div
              key={item.id}
              data-testid={item.role === 'assistant' ? 'assistant-message' : 'user-message'}
              className={cn(
                'max-w-[80ch] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm leading-relaxed',
                item.role === 'user' ? 'ml-auto bg-primary/15 text-foreground' : 'bg-muted/40 text-foreground',
              )}
            >
              {item.text}
            </div>
          );
        })}
        {view.error && <div className="text-sm text-red-500">{view.error}</div>}
        <div ref={endRef} />
      </div>

      <div className="flex items-end gap-2 border-t border-border/60 px-4 py-3">
        <textarea
          data-testid="composer"
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Ask the agent to do something…"
          className="flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
        />
        {busy ? (
          <Button
            variant="destructive"
            data-testid="stop-button"
            onClick={() => void sendCommand({ type: 'session.stop', sessionId })}
          >
            Stop
          </Button>
        ) : (
          <Button variant="primary" data-testid="send-button" onClick={() => void submit()} disabled={!draft.trim()}>
            Send
          </Button>
        )}
      </div>
    </div>
  );
}
