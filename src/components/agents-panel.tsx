"use client";

import { useState, useCallback, type CSSProperties } from "react";

import { Bot, ChevronDown, Loader2, Wrench } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ReadFailed } from "@/components/ui/read-failed";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { useAgents } from "@/hooks/use-agents";
import { hueFor } from "@/lib/bead-labels";
import { cn } from "@/lib/utils";
import type { Agent, AgentModel } from "@/types";

export interface AgentsPanelProps {
  /** Whether the panel is open */
  open: boolean;
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void;
  /** Absolute path to the project root */
  projectPath: string;
}

/** All available model options */
const MODEL_OPTIONS: AgentModel[] = ["haiku", "sonnet", "opus"];

/**
 * Format the tools display for collapsed view.
 */
function formatToolsSummary(tools: string[] | "*"): string {
  if (tools === "*") return "All tools";
  if (tools.length === 0) return "No tools";
  if (tools.length <= 2) return tools.join(", ");
  return `${tools.slice(0, 2).join(", ")} +${tools.length - 2}`;
}

/**
 * Model badge component for displaying the current model.
 */
function ModelBadge({ model }: { model: AgentModel }) {
  // The model's name is data, so it carries its own hue and keeps it wherever
  // it is drawn (src/lib/bead-labels.ts).
  return (
    <Badge size="xs" appearance="light" hue={hueFor(model)}>
      {model}
    </Badge>
  );
}

/**
 * Single agent card with collapsible details.
 */
function AgentCard({
  agent,
  isExpanded,
  onToggle,
  onUpdateModel,
  onToggleAllTools,
  isUpdating,
}: {
  agent: Agent;
  isExpanded: boolean;
  onToggle: () => void;
  onUpdateModel: (model: AgentModel) => void;
  onToggleAllTools: () => void;
  isUpdating: boolean;
}) {
  const hasAllTools = agent.tools === "*";

  return (
    <div className="rounded-lg border border-b-default bg-surface-raised/50 overflow-hidden">
      {/* Collapsed header - always visible, clickable */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        className="w-full text-left p-3 flex items-start gap-2.5 hover:bg-surface-overlay/30 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <div className="flex-1 min-w-0 space-y-1">
          {/* Name row */}
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-t-primary truncate">
              {agent.name}
            </span>
            <ModelBadge model={agent.model} />
          </div>

          {/* Description */}
          <p className="text-xs text-t-muted line-clamp-1 text-pretty">
            {agent.description || "No description"}
          </p>

          {/* Tools summary */}
          <div className="flex items-center gap-1 text-xs text-t-muted">
            <Wrench className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{formatToolsSummary(agent.tools)}</span>
          </div>
        </div>

        {/* Expand chevron */}
        <ChevronDown
          className={cn(
            "size-4 text-t-muted shrink-0 mt-0.5 transition-transform",
            isExpanded && "rotate-180"
          )}
          aria-hidden="true"
        />
      </button>

      {/* Expanded details */}
      {isExpanded && (
        <div className="border-t border-b-default p-3 space-y-3">
          {/* Model selector */}
          <div className="space-y-1.5">
            <span id={`model-label-${agent.filename}`} className="text-xs font-medium text-t-tertiary">Model</span>
            <div
              className="flex gap-1"
              role="radiogroup"
              aria-labelledby={`model-label-${agent.filename}`}
            >
              {MODEL_OPTIONS.map((model) => {
                const isSelected = agent.model === model;
                return (
                  <button
                    key={model}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    disabled={isUpdating}
                    onClick={() => onUpdateModel(model)}
                    className={cn(
                      "flex-1 h-7 rounded-md text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                      isSelected
                        ? "badge-hue border"
                        : "bg-surface-overlay/50 text-t-muted hover:text-t-secondary hover:bg-surface-overlay border border-transparent"
                    )}
                    style={isSelected ? ({ "--tag-h": String(hueFor(model)) } as CSSProperties) : undefined}
                  >
                    {model}
                  </button>
                );
              })}
            </div>
          </div>

          {/* All-tools toggle */}
          <div className="flex items-center justify-between">
            <label
              htmlFor={`all-tools-${agent.filename}`}
              className="text-xs font-medium text-t-tertiary"
            >
              All tools
            </label>
            <button
              id={`all-tools-${agent.filename}`}
              type="button"
              role="switch"
              aria-checked={hasAllTools}
              disabled={isUpdating}
              onClick={onToggleAllTools}
              className={cn(
                "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                hasAllTools
                  ? "bg-blocked-accent/30 border-blocked-accent/40"
                  : "bg-surface-overlay border-b-strong"
              )}
            >
              <span
                className={cn(
                  "pointer-events-none block size-3.5 rounded-full transition-transform",
                  hasAllTools
                    ? "translate-x-[18px] bg-blocked-accent"
                    : "translate-x-[3px] bg-t-muted"
                )}
              />
            </button>
          </div>

          {/* Tools list (when not all tools) */}
          {!hasAllTools && Array.isArray(agent.tools) && agent.tools.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-t-tertiary">
                Tools ({agent.tools.length})
              </p>
              <div className="flex flex-wrap gap-1">
                {agent.tools.map((tool) => (
                  <Badge key={tool} variant="secondary" appearance="light" size="xs" className="font-mono">
                    {tool}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Updating indicator */}
          {isUpdating && (
            <div role="status" aria-live="polite" className="flex items-center gap-1.5 text-xs text-t-muted">
              <Loader2
                className="size-3 animate-spin"
                aria-hidden="true"
              />
              Saving...
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Agents Panel - slide-out Sheet for browsing and configuring project agents
 */
export function AgentsPanel({
  open,
  onOpenChange,
  projectPath,
}: AgentsPanelProps) {
  const { agents, isLoading, error, updateAgent, refresh } = useAgents(projectPath, open);

  // Track which card is expanded
  const [expandedFilename, setExpandedFilename] = useState<string | null>(null);

  // Track which agent is being updated
  const [updatingFilename, setUpdatingFilename] = useState<string | null>(null);

  /**
   * Toggle expanded state for a card
   */
  const handleToggle = useCallback((filename: string) => {
    setExpandedFilename((prev) => (prev === filename ? null : filename));
  }, []);

  /**
   * Handle model change for an agent
   */
  const handleUpdateModel = useCallback(
    async (agent: Agent, model: AgentModel) => {
      if (model === agent.model) return;
      setUpdatingFilename(agent.filename);
      try {
        await updateAgent(agent.filename, model, agent.tools === "*");
      } catch {
        // Error is logged in hook
      } finally {
        setUpdatingFilename(null);
      }
    },
    [updateAgent]
  );

  /**
   * Handle all-tools toggle for an agent
   */
  const handleToggleAllTools = useCallback(
    async (agent: Agent) => {
      const currentlyAllTools = agent.tools === "*";
      setUpdatingFilename(agent.filename);
      try {
        await updateAgent(agent.filename, agent.model, !currentlyAllTools);
      } catch {
        // Error is logged in hook
      } finally {
        setUpdatingFilename(null);
      }
    },
    [updateAgent]
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-lg md:max-w-xl bg-surface-base border-b-default flex flex-col"
      >
        <SheetHeader className="space-y-1">
          <SheetTitle className="flex items-center gap-2 text-t-primary">
            <Bot className="size-5" aria-hidden="true" />
            Agents
          </SheetTitle>
          <SheetDescription className="text-t-muted">
            {isLoading
              ? "Loading..."
              : `${agents.length} ${agents.length === 1 ? "agent" : "agents"}`}
          </SheetDescription>
        </SheetHeader>

        {/* Agents list */}
        <ScrollArea className="flex-1 mt-4 -mx-6 px-6">
          <div className="space-y-2 pb-4">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2
                  className="size-5 text-t-muted animate-spin"
                  aria-hidden="true"
                />
                <span className="sr-only">Loading agents</span>
              </div>
            ) : error ? (
              <ReadFailed
                data-testid="agents-error"
                what="This project’s agents could not be read."
                why={error.message}
                onRetry={() => void refresh()}
              />
            ) : agents.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Bot
                  className="size-8 text-t-faint mb-3"
                  aria-hidden="true"
                />
                <p className="text-sm text-t-muted">No agents configured</p>
                <p className="text-xs text-t-faint mt-1">
                  Add agent files to .claude/agents/ to get started
                </p>
              </div>
            ) : (
              agents.map((agent) => (
                <AgentCard
                  key={agent.filename}
                  agent={agent}
                  isExpanded={expandedFilename === agent.filename}
                  onToggle={() => handleToggle(agent.filename)}
                  onUpdateModel={(model) => handleUpdateModel(agent, model)}
                  onToggleAllTools={() => handleToggleAllTools(agent)}
                  isUpdating={updatingFilename === agent.filename}
                />
              ))
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
