'use client';

/**
 * Create task for grid cells (docs/grids.md, "Work on cells"): the owner picks
 * cells, then a chat — a new one or one of the project's — and the app makes
 * a task claiming them in that chat and opens it.
 */
import { useMemo, useState, type ReactNode } from 'react';

import { MessageSquare, MessageSquarePlus, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Row } from '@/components/ui/row';
import { Spinner } from '@/components/ui/spinner';
import { tasks as tasksApi, type GridTaskCells } from '@/lib/api';
import { useLiveSessions } from '@/workbench/live';
import type { Task } from '@/workbench/tasks/types';

/** The project's chats by name, for picking where a task goes. */
export function useProjectChats(projectId: string): Array<{ id: string; name: string }> {
  const live = useLiveSessions();
  return useMemo(
    () => live
      .filter((s) => s.projectId === projectId)
      .map((s) => ({ id: s.id, name: s.name || s.title || 'Untitled chat' }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [live, projectId],
  );
}

const failure = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^API error: \d+\s*/, '');

/** `5 cells`, `1 cell`. */
export const cellCount = (n: number): string => `${n} ${n === 1 ? 'cell' : 'cells'}`;

/**
 * The Create task button: a menu of New chat and the project's chats. Picking
 * one makes the task there and opens the chat; a refusal is shown in the menu.
 */
export function CreateTaskButton({ projectId, cells, label, disabled, size = 'sm', testId = 'grid-create-task', onCreated, onOpenChat }: {
  projectId: string;
  cells: GridTaskCells;
  /** What the button says, e.g. `Create task · 5 cells`. */
  label: ReactNode;
  disabled?: boolean;
  size?: 'sm' | 'xs';
  testId?: string;
  /** The task was made: show its cells claimed. */
  onCreated?: (made: { task: Task; sessionId: string }) => void;
  /** Opens the chat the task went to. */
  onOpenChat?: (sessionId: string) => void;
}) {
  const chats = useProjectChats(projectId);
  const [open, setOpen] = useState(false);
  // The chat being asked for: a session id, or `new`.
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async (chat: string) => {
    setBusy(chat);
    setError(null);
    try {
      const made = await tasksApi.createForCells(projectId, cells, chat);
      setOpen(false);
      onCreated?.(made);
      onOpenChat?.(made.sessionId);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setError(null); }}>
      <PopoverTrigger asChild>
        <Button type="button" size={size} variant="primary" data-testid={testId} disabled={disabled} loading={busy !== null}>
          {busy === null && <Plus aria-hidden />}
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1" data-testid="create-task-chats">
        <p className="px-2 py-1.5 text-xs text-muted-foreground">Create the task in</p>
        <Row
          gap="md"
          inset="sm"
          radius="md"
          data-testid="create-task-new-chat"
          disabled={busy !== null}
          onClick={() => void create('new')}
        >
          {busy === 'new' ? <Spinner className="size-4 shrink-0" /> : <MessageSquarePlus className="size-4 shrink-0" aria-hidden />}
          <span className="text-sm">New chat</span>
        </Row>
        <div className="max-h-64 overflow-y-auto">
          {chats.map((chat) => (
            <Row
              key={chat.id}
              gap="md"
              inset="sm"
              radius="md"
              data-testid="create-task-chat"
              data-session={chat.id}
              disabled={busy !== null}
              onClick={() => void create(chat.id)}
            >
              {busy === chat.id
                ? <Spinner className="size-4 shrink-0" />
                : <MessageSquare className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
              <span className="min-w-0 truncate text-sm">{chat.name}</span>
            </Row>
          ))}
        </div>
        {error && <p role="alert" data-testid="create-task-error" className="px-2 py-1.5 text-xs text-destructive">{`Couldn't create task. ${error}`}</p>}
      </PopoverContent>
    </Popover>
  );
}
