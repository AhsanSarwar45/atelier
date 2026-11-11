/**
 * Tasks as the server hands them over (docs/tasks.md, "HTTP" and "Types").
 *
 * The plan and result shapes are written out per type so the card can draw
 * each one for what it is. They are read loosely: a field the server leaves
 * out is drawn as missing rather than taken as a broken task.
 */

import type { SessionState } from '@/workbench/protocol';

export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'review', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_TYPES = [
  'bug', 'feature', 'ui_change', 'optimization', 'plan', 'investigation',
  'refactor', 'tests', 'review', 'qa', 'docs', 'chore', 'general',
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export interface ListItem { id: string; text: string }
export interface Followup { type: string; title: string; why: string }

export interface BugPlan { symptom: string; repro_steps: string[]; expected: string; actual: string; suspected_area?: string }
export interface BugResult { root_cause: string; fix: string; proof: string; regression_checked: string[] }

export interface FeaturePlan { outcome: string; criteria: ListItem[] }
export interface FeatureResult { criteria: Array<{ id: string; met: boolean; evidence: string; reason?: string }> }

export interface UiChangePlan { screens: Array<{ id: string; name: string; how_to_reach: string; change: string }> }
export interface UiChangeResult { screens: Array<{ id: string; before: string; after: string; notes?: string }> }

export interface OptimizationTarget {
  id: string; name: string; metric: string; unit: string; baseline: number; target: number;
  how_measured: string; environment: string; higher_is_better?: boolean;
}
export interface OptimizationPlan { targets: OptimizationTarget[] }
export interface OptimizationOutcome {
  id: string; before: number; after: number; runs: number;
  /** Worked out by the server; recomputed here when it is absent. */
  met?: boolean;
  why_faster?: string; failure_reason?: string;
}
export interface OptimizationResult { method: string; targets: OptimizationOutcome[] }

export interface PlanPlan { question: string; scope: string; constraints: string[] }
export interface PlanResult { document: string; decisions: string[]; open_questions: string[]; proposed_tasks: Followup[] }

export interface InvestigationPlan { questions: ListItem[] }
export interface InvestigationResult {
  answers: Array<{ id: string; answer: string; evidence: string[]; confidence: 'low' | 'medium' | 'high'; recommendation?: string }>;
}

export interface RefactorPlan { change: string; reason: string; invariants: ListItem[] }
export interface RefactorResult { invariants: Array<{ id: string; how_verified: string }>; files_changed: number | string; net_lines: number | string; deviations: string[] }

export interface TestsPlan { behaviors: ListItem[] }
export interface TestsResult { behaviors: Array<{ id: string; test_path: string; test_name: string; fails_without_code: boolean; reason?: string }> }

export interface ReviewPlan { target: string; focus: string[] }
export interface ReviewFinding { severity: 'high' | 'medium' | 'low'; location: string; summary: string; failure_scenario: string }
export interface ReviewResult { verdict: 'approve' | 'changes_needed'; findings: ReviewFinding[] }

export interface QaPlan { scenarios: Array<{ id: string; steps: string[]; expected: string }> }
export interface QaResult { scenarios: Array<{ id: string; passed: boolean; evidence: string; notes?: string }> }

export interface DocsPlan { audience: string; pages: Array<{ id: string; path: string; change: string }> }
export interface DocsResult { pages: Array<{ id: string; path: string; what_changed: string }> }

export interface ChorePlan { steps: ListItem[] }
export interface ChoreResult { steps: Array<{ id: string; done: boolean; output?: string; reason?: string }> }

export interface GeneralPlan { outcome: string; done_when: ListItem[] }
export interface GeneralResult { done_when: Array<{ id: string; met: boolean; evidence: string; reason?: string }> }

/** The fields every finished task carries beside its type's own result. */
export interface SharedDone { summary?: string; commits?: string[]; followups?: Followup[] }

export interface Task {
  projectId: string;
  number: number;
  type: TaskType | string;
  title: string;
  why: string;
  status: TaskStatus;
  sessionId: string | null;
  sessionTitle?: string | null;
  createdBy?: string | null;
  plan: Record<string, unknown>;
  result: (Record<string, unknown> & SharedDone) | null;
  shortfalls: boolean;
  blocked: { cause: string; needed_to_resume: string } | null;
  cancelReason: string | null;
  pendingAmend: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /**
   * For a done task with commits: whether every commit is in the base branch
   * (docs/tasks.md, "Merging"). Null when there is nothing to say; absent on
   * a card printed by the CLI.
   */
  merged?: boolean | null;
}

/** Where a proposal stands: waiting, or the owner's answer. */
export type ProposalStatus = 'pending' | 'created' | 'just_do_it' | 'cancelled';

/** The owner's three answers to a proposal. */
export type ProposalChoice = 'create' | 'just_do_it' | 'cancel';

/**
 * A task an agent asked the owner about (`atelier task propose`). Not a task:
 * it has no number until the owner says Create task.
 */
export interface TaskProposal {
  projectId: string;
  id: number;
  sessionId: string;
  type: TaskType | string;
  title: string;
  why: string;
  plan: Record<string, unknown>;
  status: ProposalStatus;
  /** The task it became, once the owner said Create task. */
  taskNumber: number | null;
  createdAt: number;
  decidedAt: number | null;
}

export type TaskEventKind =
  | 'created' | 'started' | 'blocked' | 'unblocked' | 'amend_proposed' | 'amend_approved'
  | 'amend_rejected' | 'done' | 'submitted' | 'approved' | 'reopened' | 'cancelled' | 'taken' | 'released';

export interface TaskEvent {
  seq: number;
  at: number;
  kind: TaskEventKind | string;
  sessionId: string | null;
  actor: 'agent' | 'owner';
  payload: unknown;
}

export interface TaskTypeInfo { name: string; code: boolean; review: boolean; plan: unknown; result: unknown }

export type OwnerAction = 'approve' | 'reopen' | 'approve_amend' | 'reject_amend' | 'cancel' | 'release';

/**
 * The `task` chat widget: the card printed by every `atelier task` change, or
 * by `atelier task propose` the draft with the owner's three buttons.
 */
export type TaskWidget =
  | { type: 'task'; title?: string; event: string; task: Task; proposal?: undefined }
  | { type: 'task'; title?: string; event: 'propose'; proposal: TaskProposal; task?: undefined };

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'Todo',
  in_progress: 'In progress',
  blocked: 'Blocked',
  review: 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
};

export const TYPE_LABEL: Record<TaskType, string> = {
  bug: 'Bug',
  feature: 'Feature',
  ui_change: 'UI change',
  optimization: 'Optimization',
  plan: 'Plan',
  investigation: 'Investigation',
  refactor: 'Refactor',
  tests: 'Tests',
  review: 'Review',
  qa: 'QA',
  docs: 'Docs',
  chore: 'Chore',
  general: 'General',
};

export const typeLabel = (type: string): string => TYPE_LABEL[type as TaskType] ?? type;

/** Whether an optimization target was reached, from the numbers alone. */
export function targetMet(target: Pick<OptimizationTarget, 'target' | 'higher_is_better'>, after: number): boolean {
  return target.higher_is_better ? after >= target.target : after <= target.target;
}

/** The line a follow-up puts in the composer to become a task. */
export function followupLine(item: Followup): string {
  return `@task ${item.type}: ${item.title} — ${item.why}`;
}

/** A chat that is not running: its in-progress task is shown as paused. */
export function sessionStopped(state: SessionState | undefined): boolean {
  return state === 'stopped' || state === 'errored' || state === 'dormant';
}
