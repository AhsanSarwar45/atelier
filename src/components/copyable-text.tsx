"use client";

import { useState, useCallback } from "react";

import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { toast } from "@/hooks/use-toast";
import { COPY_REFUSED, copyText as copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

interface CopyableTextProps {
  /** Text to display */
  children: React.ReactNode;
  /** Text to copy to clipboard (defaults to children text content) */
  copyText: string;
  className?: string;
}

/**
 * Inline text that copies to clipboard on click.
 * Shows a checkmark + "Copied" for 2 seconds after copying.
 */
export function CopyableText({ children, copyText, className }: CopyableTextProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!(await copyToClipboard(copyText))) return void toast(COPY_REFUSED);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [copyText]);

  if (copied) {
    return (
      <span className={cn("inline-flex items-center gap-0.5 text-success", className)}>
        <Check className="size-3" aria-hidden="true" />
        Copied
      </span>
    );
  }

  return (
    <Tooltip label={`Copy ${copyText}`}>
      {/* A button, so the keyboard can copy it too. It is a word on a line
          of text — a card's id — so on a phone it takes the invisible band
          rather than the painted floor that would make the line 44px tall. */}
      <Button
        type="button"
        mode="link"
        variant="inverse"
        underline="solid"
        size="inherit"
        data-reach="band"
        onClick={handleCopy}
        className={cn("cursor-copy", className)}
      >
        {children}
      </Button>
    </Tooltip>
  );
}
