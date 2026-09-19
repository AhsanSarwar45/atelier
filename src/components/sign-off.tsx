"use client";

import { useState } from "react";

import { CheckCircle2, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { truncate } from "@/lib/bead-utils";
import { closeBead } from "@/lib/cli";
import { cn } from "@/lib/utils";

/**
 * The manager's sign-off, shared by the two kinds of card on the board.
 *
 * Manager Review is the one column no session may move a card out of — the
 * board's own check (`server/src/board_gate.rs`) refuses every drag out of it,
 * forward, back or to done — so the screen is the only place a card sitting
 * there can be finished. That made the button the sole way out, and it was
 * built inside the job card alone: a plain card that reached the manager's
 * column could be finished from nowhere at all (bw-2l3k). Both cards now ask
 * the same code for it, so neither can drift from the other.
 */

/**
 * Pressing the sign-off, and whether a press is still in the air.
 *
 * Answered the moment it is pressed rather than when the work behind it
 * finishes. Finishing runs the board program, which on this machine takes
 * seconds while it is quiet and was measured at 35 while other agents were
 * writing to the board; until then the only sign the press had landed was a
 * twelve-pixel spinner inside the button, which reads as a screen that did
 * nothing (bw-x1fv.8).
 *
 * The card stays where it is until the board says it moved — a card that
 * jumped to Done on the press would be telling the manager something the board
 * had not agreed to yet, and a card whose close fails would have to jump back.
 */
export function useSignOff(
  id: string,
  title: string,
  projectPath?: string,
  onUpdate?: () => void,
) {
  const [isMarking, setIsMarking] = useState(false);

  const signOff = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isMarking) return;

    setIsMarking(true);
    toast({ title: `Marking ${id} done…`, description: 'Updating the board…' });
    try {
      await closeBead(id, projectPath);
      toast({ title: `${id} is done`, description: truncate(title, 80) });
      onUpdate?.();
    } catch (error) {
      // Silent before this: the spinner stopped, the card stayed where it was,
      // and nothing said whether it had worked. The board is read again either
      // way, because the commonest failure here is the request giving up at
      // thirty seconds on a close that went on to succeed.
      toast({
        variant: 'destructive',
        title: `Could not mark ${id} done`,
        description: error instanceof Error ? error.message : 'Unknown error',
      });
      onUpdate?.();
    } finally {
      setIsMarking(false);
    }
  };

  return { isMarking, signOff };
}

export interface SignOffButtonProps {
  /** Whether a press is still in the air. */
  isMarking: boolean;
  onPress: (e: React.MouseEvent) => void;
  /** Extra classes for the card that draws it, which sizes its own room. */
  className?: string;
}

/**
 * The button itself, named for what the manager is doing rather than for the
 * card it acts on.
 */
export function SignOffButton({ isMarking, onPress, className }: SignOffButtonProps) {
  return (
    <Button
      variant="outline"
      size="xs"
      onClick={onPress}
      disabled={isMarking}
      className={cn(
        "border-success/30 text-success hover:bg-success/10 hover:text-success/80",
        className,
      )}
    >
      {isMarking
        ? <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        : <CheckCircle2 className="size-3" aria-hidden="true" />}
      {isMarking ? 'Marking…' : 'Mark Done'}
    </Button>
  );
}
