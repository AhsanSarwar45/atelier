/**
 * The Chat tab: transcript, composer, Stop button, permission cards, the tool
 * feed with its diffs and subagent nesting, and the checklist.
 *
 * Design: docs/agent-workbench.md §8.2. The sidebar, the card rail and the
 * report viewer arrive with their own work items.
 */
'use client';

import { useEffect, useRef, useState } from 'react';

import { TabTools } from '@/components/shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { diffLines } from '@/workbench/line-diff';
import { ChatSidebar } from '@/workbench/chat-sidebar';
import { ReportCard } from '@/workbench/report-view';
import { SearchPanel } from '@/workbench/search-panel';
import { SpendView } from '@/workbench/spend-view';
import type { AskOption, Cost, ImagePayload, TodoItem } from '@/workbench/protocol';
import {
  isBusy,
  readImage,
  sendCommand,
  useSession,
  useStartSession,
  type TranscriptItem,
} from '@/workbench/use-session';

interface ChatTabProps {
  projectId: string | null;
  projectPath: string | null;
  /** Attach to this existing session instead of offering a new one. */
  openSessionId?: string | null;
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
      <Panel
        data-testid="permission-card"
        data-ask-state="resolved"
        data-ask-id={askId}
        data-tool-name={toolName}
        className="text-sm text-muted-foreground"
      >
        <span data-testid="permission-resolved" className="font-medium text-foreground">
          {answered}
        </span>
        {' · '}
        {title}
      </Panel>
    );
  }

  return (
    <Panel
      tone="attention"
      inset="md"
      data-testid="permission-card"
      data-ask-state="open"
      data-ask-id={askId}
      data-tool-name={toolName}
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
    </Panel>
  );
}

/** Before and after in two columns, with only the lines that differ marked. */
function DiffView({ path, before, after }: { path: string; before: string; after: string }) {
  const rows = diffLines(before, after);
  return (
    <div data-testid="diff-view" data-diff-path={path} className="mt-1.5 overflow-hidden rounded border border-border/50">
      <div className="flex items-center justify-between bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
        <span className="truncate">{path}</span>
        <span className="shrink-0">before → after</span>
      </div>
      <div className="max-h-64 overflow-auto">
        <table className="w-full table-fixed border-collapse font-mono text-[11px] leading-relaxed">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} data-diff-kind={r.kind}>
                <td
                  className={cn(
                    'w-1/2 whitespace-pre-wrap break-all border-r border-border/40 px-2 py-0.5 align-top',
                    r.kind === 'removed' || r.kind === 'changed' ? 'bg-red-500/15 text-red-200' : 'text-muted-foreground',
                  )}
                >
                  {r.left ?? ''}
                </td>
                <td
                  className={cn(
                    'w-1/2 whitespace-pre-wrap break-all px-2 py-0.5 align-top',
                    r.kind === 'added' || r.kind === 'changed' ? 'bg-emerald-500/15 text-emerald-200' : 'text-muted-foreground',
                  )}
                >
                  {r.right ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ToolRow({ item, nested }: { item: Extract<TranscriptItem, { kind: 'tool' }>; nested: boolean }) {
  const dot =
    item.status === 'running' ? 'bg-amber-400 animate-pulse' : item.status === 'ok' ? 'bg-emerald-500' : 'bg-red-500';
  return (
    <div
      data-testid={nested ? 'subagent-tool-row' : 'tool-row'}
      data-tool-status={item.status}
      data-tool-name={item.name}
      className={cn(nested && 'ml-6 border-l-2 border-violet-500/50 pl-3')}
    >
      <Panel inset="none" className="flex items-center gap-2 px-2.5 py-1.5 font-mono text-xs text-muted-foreground">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', dot)} />
        <span className="truncate">{item.title}</span>
        <span className="ml-auto shrink-0 uppercase tracking-wide">{item.status}</span>
      </Panel>
      {item.diff && <DiffView path={item.diff.path} before={item.diff.before} after={item.diff.after} />}
    </div>
  );
}

/** The agent's checklist, as it stands right now. */
function TodoPanel({ items }: { items: TodoItem[] }) {
  if (!items.length) return null;
  return (
    <Panel data-testid="todo-panel">
      <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Checklist</div>
      <ul className="space-y-1">
        {items.map((t) => (
          <li key={t.id} data-testid="todo-item" data-todo-status={t.status} className="flex items-center gap-2 text-sm">
            <span
              className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border text-[10px]',
                t.status === 'completed'
                  ? 'border-emerald-500 bg-emerald-500/20 text-emerald-300'
                  : t.status === 'in_progress'
                    ? 'animate-pulse border-amber-400 bg-amber-400/20 text-amber-300'
                    : 'border-border text-transparent',
              )}
            >
              {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : ''}
            </span>
            <span className={cn(t.status === 'completed' && 'text-muted-foreground line-through')}>{t.text}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export default function ChatTab({ projectId, projectPath, openSessionId }: ChatTabProps) {
  const { sessionId, open, start, starting, error: startError } = useStartSession(projectId, projectPath, openSessionId);
  const view = useSession(sessionId);
  const [draft, setDraft] = useState('');
  const [attached, setAttached] = useState<ImagePayload[]>([]);
  /** Only ever seen on a narrow screen; the rail is always there on a wide one. */
  const [railOpen, setRailOpen] = useState(false);
  /** The two ways in that live in this tab's toolbar, each a full-screen panel. */
  const [showing, setShowing] = useState<'search' | 'spend' | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [view.items]);

  const busy = isBusy(view.state);

  async function submit() {
    const text = draft.trim();
    if (!text || !sessionId) return;
    const images = attached;
    setDraft('');
    setAttached([]);
    await sendCommand({ type: 'prompt.send', sessionId, text, images });
  }

  /** Pictures arrive by paste or by drop; both land in the same tray. */
  async function absorb(files: FileList | File[] | null) {
    const pictures = Array.from(files ?? []).filter((f) => f.type.startsWith('image/'));
    if (!pictures.length) return;
    const read = await Promise.all(pictures.map(readImage));
    setAttached((prev) => [...prev, ...read]);
  }

  if (!projectId || !projectPath) {
    return <div className="p-8 text-muted-foreground">Pick a project to start a chat.</div>;
  }

  /**
   * On a phone the conversation gets the whole screen and the list of chats
   * becomes a drawer over it: a 288px rail beside a 390px screen leaves the
   * transcript unreadable, and the composer is what must stay in reach.
   */
  const shell = (inner: React.ReactNode) => (
    // The height is the shell's to give: this box fills what the bars left.
    <div className="relative flex min-h-0 flex-1">
      <TabTools tab="chat">
        <Button size="xs" variant="outline" className="md:hidden" data-testid="chat-rail-toggle" onClick={() => setRailOpen((v) => !v)}>
          Chats
        </Button>
        <Button size="xs" variant="ghost" data-testid="open-search" onClick={() => setShowing('search')}>
          Search chats
        </Button>
        <Button size="xs" variant="ghost" data-testid="open-spend" onClick={() => setShowing('spend')}>
          What it cost
        </Button>
        <Button size="xs" variant="primary" className="ml-auto" data-testid="new-chat-tool" onClick={() => void start()} disabled={starting}>
          {starting ? 'Starting…' : 'New chat'}
        </Button>
      </TabTools>

      {showing === 'search' && <SearchPanel onClose={() => setShowing(null)} />}
      {showing === 'spend' && <SpendView onClose={() => setShowing(null)} />}

      <div
        data-testid="chat-rail"
        data-open={railOpen}
        className={cn(
          'z-30 h-full shrink-0 bg-background transition-transform md:relative md:translate-x-0',
          'absolute inset-y-0 left-0',
          railOpen ? 'translate-x-0 shadow-xl' : '-translate-x-full',
        )}
      >
        <ChatSidebar projectId={projectId} projectPath={projectPath} openSessionId={sessionId} onOpen={(id) => { setRailOpen(false); open(id); }} />
      </div>
      {railOpen && (
        <button
          type="button"
          aria-label="Close the chat list"
          data-testid="chat-rail-scrim"
          className="absolute inset-0 z-20 bg-black/40 md:hidden"
          onClick={() => setRailOpen(false)}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">{inner}</div>
    </div>
  );

  if (!sessionId) {
    return shell(
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <p className="text-muted-foreground">No chat open for this project.</p>
        <Button variant="primary" onClick={() => void start()} disabled={starting} data-testid="new-chat">
          {starting ? 'Starting…' : 'New chat'}
        </Button>
        {startError && <p className="max-w-lg text-center text-sm text-red-500">{startError}</p>}
      </div>,
    );
  }

  return shell(
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-tab" data-session-id={sessionId}>
      <div className="flex items-center gap-3 border-b border-border/60 px-4 py-2 text-sm">
        <Badge
          variant={busy ? 'warning' : 'secondary'}
          appearance="light"
          size="sm"
          shape="circle"
          data-testid="session-state"
          data-state={view.state}
        >
          {view.stateLabel}
        </Badge>
        <span data-testid="session-meta" className="text-xs text-muted-foreground">
          claude
          {view.model ? ` · ${view.model}` : ''}
          {view.permissionMode ? ` · permission mode: ${view.permissionMode}` : ''}
        </span>
        {view.beads.length > 0 && (
          <span data-testid="bead-chips" className="flex items-center gap-1">
            {view.beads.map((id) => (
              <Badge
                key={id}
                variant="primary"
                appearance="outline"
                size="sm"
                shape="circle"
                data-testid="bead-chip"
                data-bead-id={id}
                className="font-mono"
              >
                {id}
              </Badge>
            ))}
          </span>
        )}
        {view.cost && (
          <Badge variant="secondary" appearance="light" size="sm" data-testid="cost-chip" className="ml-auto font-mono">
            {costLabel(view.cost)}
          </Badge>
        )}
      </div>

      {view.todos.length > 0 && (
        <div className="border-b border-border/60 px-4 py-2">
          <TodoPanel items={view.todos} />
        </div>
      )}

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4" data-testid="transcript">
        {view.items.map((item) => {
          if (item.kind === 'tool') return <ToolRow key={item.id} item={item} nested={item.parentId !== null} />;
          if (item.kind === 'report') {
            return <ReportCard key={item.id} project={item.project} slug={item.slug} fsPath={projectPath} />;
          }
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
              {item.images.map((img, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={i}
                  data-testid="message-image"
                  src={img.dataUrl}
                  alt={img.alt}
                  className="mb-2 max-h-64 max-w-full rounded border border-border/60"
                />
              ))}
              {item.text}
            </div>
          );
        })}
        {view.error && <div className="text-sm text-red-500">{view.error}</div>}
        <div ref={endRef} />
      </div>

      <div className="border-t border-border/60 px-4 py-3">
        {attached.length > 0 && (
          <div data-testid="attachment-tray" className="mb-2 flex flex-wrap gap-2">
            {attached.map((img, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={img.dataUrl}
                alt={img.alt}
                title={img.alt}
                className="h-12 w-12 rounded border border-border/60 object-cover"
              />
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
        <input
          data-testid="image-input"
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => void absorb(e.target.files)}
        />
        <Textarea
          data-testid="composer"
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => void absorb(Array.from(e.clipboardData.files))}
          onDrop={(e) => {
            e.preventDefault();
            void absorb(e.dataTransfer.files);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Ask the agent to do something…"
          className="flex-1 resize-none bg-background"
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
    </div>,
  );
}
