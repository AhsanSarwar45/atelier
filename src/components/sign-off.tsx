"use client";

import { useState } from "react";

import { CheckCircle2, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { truncate } from "@/lib/bead-utils";
import * as api from "@/lib/api";
import { cn } from "@/lib/utils";

/** Manager approval records the reviewed tree. Landing alone completes work. */
export function useSignOff(
  id: string,
  title: string,
  projectPath?: string,
  onUpdate?: () => void,
  tree?: string,
) {
  const [isMarking, setIsMarking] = useState(false);

  const signOff = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isMarking || !tree || !projectPath) return;

    setIsMarking(true);
    toast({ title: `Approving ${id}…`, description: 'Recording approval before landing…' });
    try {
      await api.beads.update({ path: projectPath, id, approve_tree: tree });
      toast({ title: `${id} is approved for landing`, description: truncate(title, 80) });
      onUpdate?.();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: `Could not approve ${id}`,
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
      {isMarking ? 'Approving…' : 'Approve reviewed change'}
    </Button>
  );
}
