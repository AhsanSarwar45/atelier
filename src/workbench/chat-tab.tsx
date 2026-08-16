/**
 * The Chat tab: transcript, composer, Stop button, permission cards, the tool
 * feed with its diffs and subagent nesting, and the checklist.
 *
 * Design: docs/agent-workbench.md §8.2. The sidebar, the card rail and the
 * report viewer arrive with their own work items.
 */
'use client';

import { useEffect, useRef, useState } from 'react';

import { ArrowUp, Bot, MessageSquarePlus, PanelLeft, Paperclip, Receipt, Search, Square } from 'lucide-react';

import { BeadChipRow } from '@/components/bead-chip-row';
import { MarkdownBody } from '@/components/markdown-body';
import { useReports } from '@/components/report-panel';
import { TabTools, ToolButton } from '@/components/shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { Textarea } from '@/components/ui/textarea';
import { hueFor } from '@/lib/bead-labels';
import { cn } from '@/lib/utils';
import { diffLines } from '@/workbench/line-diff';
import { ChatSidebar } from '@/workbench/chat-sidebar';
import { ReportCard, ReportChip } from '@/workbench/report-view';
import { SearchPanel } from '@/workbench/search-panel';
import { SpendView } from '@/workbench/spend-view';
import type { AskOption, Cost, ImagePayload, TodoItem } from '@/workbench/protocol';
import {
  isBusy,
  readImage,
  sendCommand,
  useSession,
  useSessionFacts,
  useStartSession,
  type TranscriptItem,
} from '@/workbench/use-session';

/** Where the "show me everything" switch is remembered between visits. */
const EVERY_CHAT = 'workbench.every-chat';

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
  const facts = useSessionFacts(sessionId);
  // What the board knows plus what this chat has been seen doing since.
  const cards = Array.from(new Set([...(facts?.beads ?? []), ...view.beads]));
  // A report names the card it belongs to, so the reports of this chat's cards
  // are this chat's reports — true for a chat this app never watched work. A
  // report belongs to the goal while a chat works that goal's steps, so a step
  // counts as its goal here: `cor-qrnj.43` finds the report on `cor-qrnj`.
  const { reports } = useReports();
  const owned = new Set(cards.flatMap((id) => [id, id.split('.')[0]!]));
  const ours = reports.filter((r) => r.card !== null && owned.has(r.card));
  const [draft, setDraft] = useState('');
  const [attached, setAttached] = useState<ImagePayload[]>([]);
  /** Only ever seen on a narrow screen; the rail is always there on a wide one. */
  const [railOpen, setRailOpen] = useState(false);
  /** The two ways in that live in this tab's toolbar, each a full-screen panel. */
  const [showing, setShowing] = useState<'search' | 'spend' | null>(null);
  /**
   * Whether the list also holds the chats an agent started for another chat.
   * Off unless he says otherwise, and remembered, because it is a way of
   * looking rather than a thing to set again each visit.
   */
  const [everything, setEverything] = useState(false);

  useEffect(() => {
    setEverything(localStorage.getItem(EVERY_CHAT) === '1');
  }, []);

  useEffect(() => {
    localStorage.setItem(EVERY_CHAT, everything ? '1' : '0');
  }, [everything]);
  const endRef = useRef<HTMLDivElement>(null);
  const typing = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [view.items]);

  // One line at rest, growing to what is written. Measured from the content,
  // because a textarea cannot shrink itself back down once it has been sized.
  useEffect(() => {
    const box = typing.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${box.scrollHeight}px`;
  }, [draft]);

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
        <ToolButton
          icon={<PanelLeft />}
          label="Chats"
          className="md:hidden"
          data-testid="chat-rail-toggle"
          onClick={() => setRailOpen((v) => !v)}
        />
        <ToolButton icon={<Search />} label="Search chats" data-testid="open-search" onClick={() => setShowing('search')} />
        <ToolButton icon={<Receipt />} label="What it cost" data-testid="open-spend" onClick={() => setShowing('spend')} />
        <ToolButton
          icon={<Bot />}
          label={everything ? 'Hide the agents’ own chats' : 'Show the agents’ own chats'}
          emphasis={everything ? 'loud' : 'quiet'}
          data-testid="toggle-everything"
          data-showing-everything={everything}
          onClick={() => setEverything((v) => !v)}
        />
        <ToolButton
          icon={<MessageSquarePlus />}
          label="New chat"
          emphasis="loud"
          className="ml-auto"
          data-testid="new-chat-tool"
          busy={starting}
          disabled={starting}
          onClick={() => void start()}
        />
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
        <ChatSidebar
          projectId={projectId}
          projectPath={projectPath}
          openSessionId={sessionId}
          everything={everything}
          onOpen={(id) => { setRailOpen(false); open(id); }}
        />
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
      {/* One line, whatever it carries: the words naming the agent never give
          way to the cards it has touched (docs/agent-workbench.md §8.2.1). */}
      <div className="flex h-10 shrink-0 items-center gap-3 overflow-hidden border-b border-border/60 px-4 text-sm">
        <Badge
          variant={busy ? 'warning' : 'secondary'}
          appearance="light"
          size="sm"
          shape="circle"
          data-testid="session-state"
          data-state={view.state}
          className="shrink-0"
        >
          {view.stateLabel}
        </Badge>
        <span data-testid="session-meta" className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
          claude
          {view.model ? ` · ${view.model}` : ''}
          {view.permissionMode ? ` · permission mode: ${view.permissionMode}` : ''}
        </span>
        <BeadChipRow
          ids={cards}
          projectId={projectId}
          place="line"
          className="flex min-w-0 items-center gap-1 overflow-hidden"
        />
        {ours.map((r) => (
          <ReportChip key={`${r.project}/${r.slug}`} project={r.project} slug={r.slug} title={r.title} fsPath={projectPath} />
        ))}
        {facts?.folder && (
          <Badge
            hue={hueFor(facts.folder)}
            appearance="light"
            size="sm"
            shape="circle"
            data-testid="chat-folder-chip"
            data-folder={facts.folder}
            data-branch={facts.branch ?? ''}
            // The whole path and the branch in the tooltip: the chip has room
            // for the one word that tells two copies of a project apart.
            title={[facts.cwd, facts.branch].filter(Boolean).join(' · ')}
            className="font-mono"
          >
            {facts.folder}
          </Badge>
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

      <div
        className="mx-auto flex w-full max-w-[110ch] flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
        data-testid="transcript"
      >
        {view.items.map((item) => {
          if (item.kind === 'tool') return <ToolRow key={item.id} item={item} nested={item.parentId !== null} />;
          if (item.kind === 'notice') {
            return (
              <p key={item.id} data-testid="transcript-notice" className="text-center text-xs text-muted-foreground">
                {item.text}
              </p>
            );
          }
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
              // The answer takes the column; what he typed stays narrower and to
              // the right, which is what tells the two apart without a label.
              className={cn(
                'rounded-lg px-3 py-2 text-sm leading-relaxed',
                item.role === 'user'
                  ? 'ml-auto max-w-[75ch] bg-primary/15 text-foreground'
                  : 'w-full bg-muted/40 text-foreground',
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
              <MarkdownBody className="text-sm">{item.text}</MarkdownBody>
            </div>
          );
        })}
        {view.error && <div className="text-sm text-red-500">{view.error}</div>}
        <div ref={endRef} />
      </div>

      <div className="border-t border-border/60 px-4 py-3">
        {/* One frame holds the typing, the pictures waiting to go and the button
            that sends them, so the whole thing reads as the place you write. */}
        <div
          data-testid="composer-frame"
          className={cn(
            'mx-auto w-full max-w-[110ch] rounded-2xl border bg-surface-raised px-4 py-3 shadow-sm transition-colors',
            'border-border focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/30',
          )}
        >
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
          <input
            ref={picker}
            data-testid="image-input"
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => void absorb(e.target.files)}
          />
          <Textarea
            ref={typing}
            data-testid="composer"
            rows={1}
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
            // The frame is the box; the typing area inside it carries no second
            // edge, no shadow and no colour of its own, and it grows with what
            // is written until it would take the conversation's room.
            className="max-h-56 w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-[15px] leading-6 shadow-none focus-visible:ring-0"
          />
          <div className="mt-1.5 flex items-center gap-1">
            {/* A plain button, not the toolbar's: that one speaks through a
                tooltip and only works inside the bar that hosts one. */}
            <Button
              variant="ghost"
              mode="icon"
              size="sm"
              aria-label="Attach a picture"
              title="Attach a picture"
              data-testid="attach-picture"
              className="rounded-full text-muted-foreground"
              onClick={() => picker.current?.click()}
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <span className="ml-auto" />
            {busy ? (
              <Button
                variant="destructive"
                mode="icon"
                size="sm"
                aria-label="Stop"
                data-testid="stop-button"
                className="rounded-full"
                onClick={() => void sendCommand({ type: 'session.stop', sessionId })}
              >
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                variant="primary"
                mode="icon"
                size="sm"
                aria-label="Send"
                data-testid="send-button"
                className="rounded-full"
                onClick={() => void submit()}
                disabled={!draft.trim()}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>,
  );
}
