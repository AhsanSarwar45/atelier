"use client";

import { useState, useRef, useEffect, useCallback } from "react";

import { Loader2, Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface EditableFieldProps {
  /** Current value */
  value: string;
  /** Called with new value on save */
  onSave: (value: string) => Promise<void>;
  /** Whether editing is disabled (e.g., dolt:// projects) */
  disabled?: boolean;
  /** Use textarea instead of input */
  multiline?: boolean;
  /** CSS class for the display text */
  className?: string;
  /** Placeholder when empty */
  placeholder?: string;
  /** Optional renderer for the display value (e.g. Markdown). Plain text used if omitted. */
  renderValue?: (value: string) => React.ReactNode;
}

/**
 * Editable field with auto-save on blur/Enter.
 * In display mode shows a small pen icon on hover; click swaps to input/textarea.
 * Layout adapts to renderValue: block (div) when provided, inline (span) when not.
 */
export function EditableField({
  value,
  onSave,
  disabled,
  multiline,
  className,
  placeholder,
  renderValue,
}: EditableFieldProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  // Sync edit value when value prop changes
  useEffect(() => {
    if (!isEditing) setEditValue(value);
  }, [value, isEditing]);

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      // Move cursor to end
      const len = inputRef.current.value.length;
      inputRef.current.setSelectionRange(len, len);
    }
  }, [isEditing]);

  const save = useCallback(async () => {
    const trimmed = editValue.trim();
    if (trimmed === value.trim() || trimmed === "") {
      setEditValue(value);
      setIsEditing(false);
      return;
    }

    setIsSaving(true);
    try {
      await onSave(trimmed);
      setIsEditing(false);
    } catch {
      // Revert on error — toast is handled by caller
      setEditValue(value);
      setIsEditing(false);
    } finally {
      setIsSaving(false);
    }
  }, [editValue, value, onSave]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setEditValue(value);
      setIsEditing(false);
    }
    if (e.key === "Enter" && !multiline) {
      e.preventDefault();
      save();
    }
    // Ctrl/Cmd+Enter for multiline
    if (e.key === "Enter" && multiline && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    }
  };

  const displayBody = value
    ? (renderValue ? renderValue(value) : value)
    : <span className="text-t-faint italic">{placeholder}</span>;

  if (disabled) {
    return <span className={className}>{displayBody}</span>;
  }

  if (isSaving) {
    return (
      <span className={cn("inline-flex items-center gap-1.5", className)}>
        <Loader2 className="size-3 animate-spin text-t-muted" />
        <span className="text-t-muted">Saving…</span>
      </span>
    );
  }

  if (isEditing) {
    if (multiline) {
      return (
        <Textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={save}
          onKeyDown={handleKeyDown}
          rows={Math.max(3, editValue.split("\n").length)}
          className={cn("resize-y px-2 py-1 text-sm", className)}
        />
      );
    }

    return (
      <Input
        ref={inputRef as React.RefObject<HTMLInputElement>}
        type="text"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={save}
        onKeyDown={handleKeyDown}
        className={cn("h-auto px-2 py-1", className)}
      />
    );
  }

  const editButton = (
    <Button
      type="button"
      variant="dim"
      mode="icon"
      size="xs"
      onClick={() => setIsEditing(true)}
      aria-label="Edit"
      className={cn(
        "size-5 opacity-0 transition-[color,box-shadow,opacity] group-hover:opacity-100 focus-visible:opacity-100",
      )}
    >
      <Pencil className="size-3.5" aria-hidden="true" />
    </Button>
  );

  // Block layout for renderValue (e.g. Markdown): div with pen absolutely top-right.
  if (renderValue) {
    return (
      <div className={cn("group relative", className)}>
        {displayBody}
        <div className="absolute top-0 right-0">{editButton}</div>
      </div>
    );
  }

  // Inline layout for plain text (e.g. title): pen sits inline after the value.
  return (
    <span className={cn("group inline-flex items-baseline gap-1.5", className)}>
      <span>{displayBody}</span>
      {editButton}
    </span>
  );
}
