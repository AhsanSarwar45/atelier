'use client';

/**
 * A plan item's checks on a card (docs/tasks.md, "Checks"): folded to
 * "3 checks" or "2 of 3 checks pass" with a dot per check; unfolded, each
 * check's name, kind, Given/When/Then, command and files, and for one that
 * failed its reason and output. Weak-check flags sit beside the item they
 * concern. The review card lists every flag before Approve and Reopen.
 */
import { createContext, useContext, type ReactNode } from 'react';

import { AlertTriangle, Minus, Pencil, Plus } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTriggerRow } from '@/components/ui/collapsible';
import { Panel } from '@/components/ui/panel';
import { cn } from '@/lib/utils';
import {
  baselineFor, benchLine, checkFieldName, checkSentence, flagTitle, flagsFor, itemRuns, kindLabel, measured, readRun,
  sortedFlags, tally, tallyLine, type Check, type CheckFlag, type CheckRun, type ItemCheckDiff,
} from '@/workbench/tasks/checks';

/** What the server measured of a task's checks, for the plan items under it. */
export interface CheckGate {
  runs?: unknown;
  met?: Record<string, boolean> | null;
  baseline?: unknown;
  flags?: readonly CheckFlag[];
}

const GateContext = createContext<CheckGate | null>(null);

export function CheckGateProvider({ gate, children }: { gate: CheckGate | null; children: ReactNode }) {
  return <GateContext.Provider value={gate}>{children}</GateContext.Provider>;
}

export function useCheckGate(): CheckGate | null {
  return useContext(GateContext);
}

/** A check's dot: green when its last run passed, red when it failed, hollow before it ran. */
function Dot({ run }: { run: CheckRun | undefined }) {
  const state = measured(run) ? (run.passed ? 'pass' : 'fail') : 'none';
  return (
    <span aria-hidden data-testid="check-dot" data-state={state} className={cn('inline-block size-2 shrink-0 rounded-full',
      state === 'pass' ? 'bg-[var(--color-success-accent)]' : state === 'fail' ? 'bg-destructive' : 'border border-muted-foreground/60')} />
  );
}

/** Flags shown as warning lines. */
export function FlagLines({ flags, testId = 'check-flag' }: { flags: readonly CheckFlag[]; testId?: string }) {
  if (!flags.length) return null;
  return (
    <ul className="space-y-0.5">
      {flags.map((flag, index) => (
        <li key={index} data-testid={testId} data-kind={flag.kind} className="flex gap-1.5 text-xs text-[var(--color-warning-accent)]">
          <AlertTriangle aria-hidden className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0 break-words">{flag.text || flagTitle(flag)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Output kept from a run: mono, scrollable. */
function Output({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <Panel asChild inset="xs">
      <pre data-testid="check-output" className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-snug text-muted-foreground">
        {text}
      </pre>
    </Panel>
  );
}

/** One check unfolded: what it proves, how it is run, and how it last came out. */
function CheckDetail({ check, run, bench }: { check: Check; run?: CheckRun; bench: string }) {
  const sentence = checkSentence(check);
  const failed = measured(run) && !run.passed;
  return (
    <li data-testid="check" data-check={check.name} data-state={measured(run) ? (run.passed ? 'pass' : 'fail') : 'none'} className="space-y-1 py-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Dot run={run} />
        <span className="font-mono text-xs text-foreground">{check.name}</span>
        <Badge variant="secondary" size="sm"><span>{kindLabel(check.kind)}</span></Badge>
      </div>
      {sentence && <p className="text-xs text-muted-foreground">{sentence}</p>}
      <code data-testid="check-command" className="block overflow-x-auto whitespace-pre font-mono text-[11px] text-foreground">{check.command}</code>
      {check.files.length > 0 && (
        <div className="break-all text-[11px] text-muted-foreground">{`Files: ${check.files.join(', ')}`}</div>
      )}
      {bench && <div data-testid="check-bench" className="text-xs tabular-nums text-foreground">{bench}</div>}
      {failed && (
        <div className="space-y-1">
          <div data-testid="check-reason" className="break-words text-xs text-destructive">{run.reason || `Exit ${run.exit ?? '?'}`}</div>
          <Output text={run.outputTail} />
        </div>
      )}
    </li>
  );
}

/**
 * A plan item's checks, folded by default, and the flags about it. Without
 * checks it shows the flags only.
 */
export function ItemChecks({ itemId, checks, flags: given }: { itemId: string; checks: readonly Check[]; flags?: readonly CheckFlag[] }) {
  const gate = useCheckGate();
  const runs = itemRuns(gate?.runs, itemId);
  const flags = given ?? flagsFor(gate?.flags ?? [], itemId);
  if (!checks.length) return <FlagLines flags={flags} />;
  const count = tally(checks, runs);
  return (
    <div data-testid="item-checks" data-item={itemId} className="space-y-1">
      <Collapsible>
        <CollapsibleTriggerRow size="sm" data-testid="item-checks-toggle" className="gap-2">
          <span data-testid="item-checks-tally" className={cn('tabular-nums', count.ran && count.passed < count.total && 'text-foreground')}>{tallyLine(count)}</span>
          {count.ran && <span className="flex items-center gap-1">{checks.map((check) => <Dot key={check.name} run={runs.get(check.name)} />)}</span>}
        </CollapsibleTriggerRow>
        <CollapsibleContent>
          <ul className="ml-1 divide-y divide-border/60 border-l border-border/60 pl-3">
            {checks.map((check) => (
              <CheckDetail key={check.name} check={check} run={runs.get(check.name)}
                bench={benchLine(check, runs.get(check.name), baselineFor(gate?.baseline, itemId, check.name))} />
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
      <FlagLines flags={flags} />
    </div>
  );
}

/** Checks drawn open, each with its name, kind, sentence, command and files: a grid cell's. */
export function CheckList({ checks, testId = 'check-list' }: { checks: readonly Check[]; testId?: string }) {
  if (!checks.length) return null;
  return (
    <ul data-testid={testId} className="divide-y divide-border/60">
      {checks.map((check) => <CheckDetail key={check.name} check={check} bench={benchLine(check, undefined, undefined)} />)}
    </ul>
  );
}

/** The plan's own checks (bug, plan, review), under the item id `plan`. */
export function PlanChecks({ checks }: { checks: readonly Check[] }) {
  if (!checks.length) return null;
  return (
    <section data-testid="plan-checks" className="space-y-1">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Checks</div>
      <ItemChecks itemId="plan" checks={checks} />
    </section>
  );
}

/** The project's test command as it ran at done. */
export function TestCommandRun({ run: value }: { run: unknown }) {
  const run = readRun(value);
  if (!run) return null;
  return (
    <div data-testid="test-command-run" data-passed={run.passed ? 'yes' : 'no'} className="space-y-1">
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <Dot run={{ ...run, phase: 'done' }} />
        <span className={run.passed ? 'text-foreground' : 'text-destructive'}>{run.passed ? 'Test command passed' : `Test command failed (exit ${run.exit ?? '?'})`}</span>
        <code className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{run.command}</code>
      </div>
      {!run.passed && <Output text={run.outputTail} />}
    </div>
  );
}

/**
 * What the server found that may make the work prove less than it claims:
 * a check that passes with the change undone, skips, exits and deleted tests
 * first, then the notes on weak checks. With the test command's result.
 */
export function CheckFlagsPanel({ flags, testCommand }: { flags: readonly CheckFlag[]; testCommand?: unknown }) {
  const sorted = sortedFlags(flags);
  const run = readRun(testCommand);
  if (!sorted.length && !run) return null;
  return (
    <Panel tone={sorted.length ? 'attention' : 'default'} inset="sm" data-testid="task-check-flags" className="space-y-2">
      {sorted.length > 0 && (
        <>
          <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <AlertTriangle aria-hidden className="size-4 text-[var(--color-warning-accent)]" />
            {`${sorted.length} ${sorted.length === 1 ? 'flag' : 'flags'} to look at before approving`}
          </div>
          <ul className="space-y-1">
            {sorted.map((flag, index) => (
              <li key={index} data-testid="task-check-flag" data-kind={flag.kind} className="text-sm">
                <span className="font-medium">{flagTitle(flag)}</span>
                {flag.text && <span className="block break-words text-xs text-muted-foreground">{flag.text}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      <TestCommandRun run={testCommand} />
    </Panel>
  );
}

function CheckLine({ check }: { check: Check }) {
  return (
    <>
      <span className="font-mono text-xs">{check.name}</span>
      <code className="block overflow-x-auto whitespace-pre font-mono text-[11px] text-muted-foreground">{check.command}</code>
    </>
  );
}

const display = (value: unknown): string => (value === undefined || value === null || value === '' ? '(none)' : Array.isArray(value) ? value.join(', ') : typeof value === 'object' ? JSON.stringify(value) : String(value));

/** The checks an amend adds, removes and changes, item by item. */
export function CheckDiffView({ diffs, itemName }: { diffs: readonly ItemCheckDiff[]; itemName: (id: string) => string }) {
  if (!diffs.length) return null;
  return (
    <div data-testid="task-amend-checks" className="space-y-2">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Checks</div>
      {diffs.map((diff) => (
        <div key={diff.id} data-testid="amend-check-item" data-item={diff.id} className="space-y-0.5">
          <div className="text-sm">{itemName(diff.id)}</div>
          <ul className="divide-y divide-border/60">
            {diff.added.map((check) => (
              <li key={`+${check.name}`} data-testid="amend-check" data-change="added" className="flex gap-2 py-1">
                <Plus aria-hidden className="mt-0.5 size-3.5 shrink-0 text-[var(--color-success-accent)]" />
                <div className="min-w-0 flex-1"><span className="sr-only">Added: </span><CheckLine check={check} /></div>
              </li>
            ))}
            {diff.removed.map((check) => (
              <li key={`-${check.name}`} data-testid="amend-check" data-change="removed" className="flex gap-2 py-1">
                <Minus aria-hidden className="mt-0.5 size-3.5 shrink-0 text-[var(--color-warning-accent)]" />
                <div className="min-w-0 flex-1 line-through opacity-70"><span className="sr-only">Removed: </span><CheckLine check={check} /></div>
              </li>
            ))}
            {diff.changed.map((change) => (
              <li key={`~${change.name}`} data-testid="amend-check" data-change="changed" className="flex gap-2 py-1">
                <Pencil aria-hidden className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <span className="font-mono text-xs">{change.name}</span>
                  {change.fields.map((field) => (
                    <div key={field} className="text-xs">
                      <span className="text-muted-foreground">{`${checkFieldName(field)}: `}</span>
                      <span className="break-all text-muted-foreground line-through">{display(change.before[field as keyof Check])}</span>
                      <span className="block break-all">{display(change.after[field as keyof Check])}</span>
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
