/**
 * The messages waiting their turn, drawn where the reader left them.
 *
 * A waiting message is not part of the conversation and is deliberately not
 * drawn as one: it sits between the transcript and the writing box, above the
 * line it will become, so it stays in sight while the agent works rather than
 * scrolling away with the answer it is queued behind. Each one carries the
 * three things that can be done to it, because a queue you cannot change is
 * worse than no queue at all (bw-r54j.5).
 *
 * Nothing in here knows which provider the chat runs on. The queue is the
 * app's, and the same row is drawn for Claude, for Codex and for a local
 * model.
 */
'use client';

import { ArrowUp, Pencil, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { HeldMessage } from '@/workbench/protocol';

/** The one-line word for where a waiting message stands in the queue. */
export function waitingWord(at: number, working: boolean): string {
  if (!working) return 'Sending now';
  return at === 0 ? 'Next, when this turn ends' : `Waiting, ${at + 1} in line`;
}

export function HeldMessages({
  held,
  working,
  onPush,
  onEdit,
  onDrop,
  busyId,
}: {
  held: HeldMessage[];
  /** Whether the chat is still working, which is what the queue waits on. */
  working: boolean;
  onPush: (held: HeldMessage) => void;
  onEdit: (held: HeldMessage) => void;
  onDrop: (held: HeldMessage) => void;
  /** The message a click is already in flight for, so it cannot be clicked twice. */
  busyId: string | null;
}) {
  if (held.length === 0) return null;
  return (
    <div
      data-testid="held-messages"
      className="mx-auto mb-2 flex w-full max-w-[110ch] flex-col gap-1.5 px-4"
    >
      {held.map((message, at) => (
        <Panel
          key={message.id}
          inset="sm"
          data-testid="held-message"
          data-held-id={message.id}
          className={cn(
            // Dashed, because it is the one box on this screen holding
            // something that has not happened yet.
            'flex items-start gap-2 border-dashed',
            busyId === message.id && 'opacity-60',
          )}
        >
          <div className="min-w-0 flex-1">
            <p
              data-testid="held-message-standing"
              className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              {waitingWord(at, working)}
            </p>
            {/* Two lines of it, whatever was written: the queue is a reminder
                of what is waiting, and the whole of a long message belongs in
                the box it goes back to when it is edited. */}
            <p data-testid="held-message-text" className="line-clamp-2 whitespace-pre-wrap break-words text-sm">
              {message.text}
            </p>
            {message.images.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {message.images.length} attachment{message.images.length === 1 ? '' : 's'}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Tooltip label="Send this now, into the turn that is running">
              <Button
                variant="ghost"
                mode="icon"
                size="sm"
                aria-label="Send now"
                data-testid="held-message-push"
                radius="full"
                disabled={busyId !== null}
                onClick={() => onPush(message)}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            </Tooltip>
            <Tooltip label="Put it back in the writing box">
              <Button
                variant="ghost"
                mode="icon"
                size="sm"
                aria-label="Edit waiting message"
                data-testid="held-message-edit"
                radius="full"
                disabled={busyId !== null}
                onClick={() => onEdit(message)}
              >
                <Pencil className="h-4 w-4" />
              </Button>
            </Tooltip>
            <Tooltip label="Drop it">
              <Button
                variant="ghost"
                mode="icon"
                size="sm"
                aria-label="Drop waiting message"
                data-testid="held-message-drop"
                radius="full"
                disabled={busyId !== null}
                onClick={() => onDrop(message)}
              >
                <X className="h-4 w-4" />
              </Button>
            </Tooltip>
          </div>
        </Panel>
      ))}
    </div>
  );
}
