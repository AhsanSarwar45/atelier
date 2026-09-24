/**
 * The chat name template of one project, as a row of parts the manager
 * arranges by dragging (bw-mv45).
 *
 * A part is the chat's title, some text, or what a pattern finds in the
 * worktree, branch or folder the chat works in. The server builds every name
 * from the saved template (server, `workbench::chat_name`), and the preview
 * under the row asks the same code what a draft would call this project's
 * latest chats.
 */
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowRight, Folder, FolderGit2, GitBranch, GripVertical, Lock, Plus, Ticket, Type, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import * as api from '@/lib/api';
import type { ChatNamePart, ChatNamePreview, ChatNameSource } from '@/lib/api';
import { cn } from '@/lib/utils';

/** The most parts a template may have (server, `chat_name::MOST_PARTS`). */
const MOST_PARTS = 12;

const SOURCES: { value: ChatNameSource; label: string; icon: typeof Folder }[] = [
  { value: 'worktree', label: 'Worktree', icon: FolderGit2 },
  { value: 'branch', label: 'Branch', icon: GitBranch },
  { value: 'path', label: 'Folder path', icon: Folder },
];

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The ticket key a worktree is named after: `bw-a9ln` for a project whose cards are `bw-`. */
export function ticketKeyPattern(prefix: string): string {
  const trimmed = prefix.trim();
  return trimmed ? `${escaped(trimmed)}-[a-z0-9]+` : '[A-Za-z]+-[0-9]+';
}

/** The template the preset button lays down: `bw-a9ln: <title>`. */
export function ticketKeyTemplate(prefix: string): ChatNamePart[] {
  return [
    { kind: 'extract', source: 'worktree', pattern: ticketKeyPattern(prefix) },
    { kind: 'text', text: ': ' },
    { kind: 'title' },
  ];
}

interface Item {
  id: string;
  part: ChatNamePart;
}

let made = 0;
const itemsOf = (parts: ChatNamePart[]): Item[] => parts.map((part) => ({ id: `part-${++made}`, part }));

export interface ChatNameEditorProps {
  projectId: string;
  parts: ChatNamePart[];
  onChange: (parts: ChatNamePart[]) => void;
  /** The project's card prefix, for the ticket key preset. */
  prefix: string;
}

export function ChatNameEditor({ projectId, parts, onChange, prefix }: ChatNameEditorProps) {
  const [items, setItems] = useState<Item[]>(() => itemsOf(parts));
  const [opened, setOpened] = useState<string | null>(null);
  const [preview, setPreview] = useState<ChatNamePreview | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);

  // A template loaded or reset from outside replaces the row; one this editor
  // just sent back up is already the row, and keeps its ids so a chip being
  // edited stays open.
  const shown = useRef(JSON.stringify(parts));
  useEffect(() => {
    const wanted = JSON.stringify(parts);
    if (wanted !== shown.current) {
      shown.current = wanted;
      setItems(itemsOf(parts));
    }
  }, [parts]);

  const change = (next: Item[]) => {
    setItems(next);
    const nextParts = next.map((item) => item.part);
    shown.current = JSON.stringify(nextParts);
    onChange(nextParts);
  };

  const key = JSON.stringify(items.map((item) => item.part));
  useEffect(() => {
    let current = true;
    const wait = setTimeout(() => {
      api.projects
        .chatNamePreview(projectId, { parts: JSON.parse(key) as ChatNamePart[] })
        .then((answer) => {
          if (!current) return;
          setPreview(answer);
          setPreviewFailed(false);
        })
        .catch(() => current && setPreviewFailed(true));
    }, 250);
    return () => {
      current = false;
      clearTimeout(wait);
    };
  }, [projectId, key]);

  const problems = useMemo(() => {
    const byIndex = new Map<number, string>();
    for (const problem of preview?.problems ?? []) byIndex.set(problem.index, problem.message);
    return byIndex;
  }, [preview]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const dragged = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = items.findIndex((item) => item.id === active.id);
    const to = items.findIndex((item) => item.id === over.id);
    if (from < 0 || to < 0) return;
    change(arrayMove(items, from, to));
  };

  const add = (part: ChatNamePart) => {
    const [item] = itemsOf([part]);
    change([...items, item]);
    if (part.kind !== 'title') setOpened(item.id);
  };

  const hasTitle = items.some((item) => item.part.kind === 'title');
  const full = items.length >= MOST_PARTS;
  const onlyText = items.length > 0 && items.every((item) => item.part.kind === 'text');

  const addMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={full} data-testid="chat-name-add">
          <Plus /> Add
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem disabled={hasTitle} onSelect={() => add({ kind: 'title' })} data-testid="chat-name-add-title">
          <Type /> Chat title
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => add({ kind: 'extract', source: 'worktree', pattern: ticketKeyPattern(prefix) })}
          data-testid="chat-name-add-extract"
        >
          <Ticket /> Extracted text
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => add({ kind: 'text', text: ' ' })} data-testid="chat-name-add-text">
          <span className="flex size-4 items-center justify-center font-mono text-xs">&quot;</span> Text
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="w-full space-y-3" data-testid="chat-name-editor">
      {items.length === 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={() => change(itemsOf(ticketKeyTemplate(prefix)))} data-testid="chat-name-preset">
            <Ticket /> Ticket key from worktree
          </Button>
          {addMenu}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragged}>
            <SortableContext items={items.map((item) => item.id)} strategy={horizontalListSortingStrategy}>
              {items.map((item, index) => (
                <Chip
                  key={item.id}
                  item={item}
                  problem={problems.get(index)}
                  open={opened === item.id}
                  onOpen={(open) => setOpened(open ? item.id : null)}
                  onChange={(part) => change(items.map((it) => (it.id === item.id ? { ...it, part } : it)))}
                  onRemove={() => change(items.filter((it) => it.id !== item.id))}
                />
              ))}
            </SortableContext>
          </DndContext>
          {addMenu}
          <Button type="button" variant="ghost" size="sm" onClick={() => change([])} data-testid="chat-name-clear">
            Clear
          </Button>
        </div>
      )}

      {onlyText && <p className="text-xs text-destructive">Add the chat title or extracted text</p>}

      {items.length > 0 && (
        <div className="space-y-1" data-testid="chat-name-preview">
          {previewFailed && <p className="text-xs text-t-tertiary">Preview unavailable</p>}
          {preview?.chats.map((chat) => (
            <div key={chat.sessionId} className="flex min-w-0 items-center gap-2 text-sm" data-testid="chat-name-preview-row">
              <span className="min-w-0 flex-1 truncate text-t-tertiary">{chat.now}</span>
              <ArrowRight className="size-3.5 shrink-0 text-t-tertiary" />
              <span className="flex min-w-0 flex-1 items-center gap-1 truncate font-medium text-t-primary" data-testid="chat-name-preview-then">
                {chat.namedByOwner && <Lock className="size-3 shrink-0 text-t-tertiary" aria-label="Named by hand" />}
                <span className="truncate">{chat.then}</span>
              </span>
            </div>
          ))}
          {preview && preview.chats.length === 0 && <p className="text-xs text-t-tertiary">No chats yet</p>}
        </div>
      )}
    </div>
  );
}

function Chip({
  item,
  problem,
  open,
  onOpen,
  onChange,
  onRemove,
}: {
  item: Item;
  problem?: string;
  open: boolean;
  onOpen: (open: boolean) => void;
  onChange: (part: ChatNamePart) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const { part } = item;
  const source = part.kind === 'extract' ? SOURCES.find((it) => it.value === part.source) : undefined;
  const SourceIcon = source?.icon;

  const label =
    part.kind === 'title' ? (
      <>
        <Type className="size-3.5" /> Chat title
      </>
    ) : part.kind === 'text' ? (
      <span className="whitespace-pre font-mono text-xs">{part.text.replace(/ /g, '·') || '∅'}</span>
    ) : (
      <>
        {SourceIcon && <SourceIcon className="size-3.5 shrink-0" />}
        <span className="max-w-48 truncate font-mono text-xs">{part.pattern || '∅'}</span>
      </>
    );

  return (
    // A chip, with the handle, the words and the cross each a button inside
    // it. The chip's own gap is the room between them.
    <Badge
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      variant={part.kind === 'title' ? 'primary' : part.kind === 'extract' ? 'info' : 'outline'}
      appearance={part.kind === 'text' ? 'default' : 'outline'}
      size="lg"
      shape="circle"
      className={cn(
        part.kind === 'text' && 'border-dashed',
        problem && 'border-destructive ring-1 ring-destructive/40',
        isDragging && 'z-10 opacity-80 shadow-md',
      )}
      data-testid="chat-name-chip"
      data-kind={part.kind}
    >
      <Button
        type="button"
        variant="dim"
        size="none"
        className="h-full cursor-grab touch-none active:cursor-grabbing"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-3.5" />
      </Button>
      {part.kind === 'title' ? (
        <span className="flex items-center gap-1.5">{label}</span>
      ) : (
        <Popover open={open} onOpenChange={onOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="foreground" size="none" className="h-full gap-1.5 hover:underline" data-testid="chat-name-chip-edit">
              {label}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 space-y-3">
            {part.kind === 'text' ? (
              <label className="block space-y-1 text-xs font-medium text-t-secondary">
                Text
                <Input
                  autoFocus
                  value={part.text}
                  onChange={(e) => onChange({ kind: 'text', text: e.target.value })}
                  className="font-mono text-xs"
                  data-testid="chat-name-text"
                />
              </label>
            ) : (
              <>
                <div className="space-y-1 text-xs font-medium text-t-secondary">
                  <span>From</span>
                  <Select value={part.source} onValueChange={(value) => onChange({ ...part, source: value as ChatNameSource })}>
                    <SelectTrigger aria-label="From" data-testid="chat-name-source">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SOURCES.map((it) => (
                        <SelectItem key={it.value} value={it.value}>
                          {it.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <label className="block space-y-1 text-xs font-medium text-t-secondary">
                  Pattern
                  <Input
                    autoFocus
                    value={part.pattern}
                    onChange={(e) => onChange({ ...part, pattern: e.target.value })}
                    className="font-mono text-xs"
                    spellCheck={false}
                    data-testid="chat-name-pattern"
                  />
                </label>
              </>
            )}
            {problem && (
              <p className="text-xs text-destructive" data-testid="chat-name-problem">
                {problem}
              </p>
            )}
          </PopoverContent>
        </Popover>
      )}
      <Button
        type="button"
        variant="dim"
        size="none"
        className="h-full"
        aria-label="Remove"
        onClick={onRemove}
        data-testid="chat-name-remove"
      >
        <X className="size-3.5" />
      </Button>
    </Badge>
  );
}
