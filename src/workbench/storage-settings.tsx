/**
 * Storage: what the app takes on disk, and the rules that clear old chats.
 *
 * The usage and the rules are both held by the server (routes/storage.rs),
 * which also runs the rules about once a day. Rules are edited here as a draft
 * and saved together, with each card showing what it would delete right now,
 * so a rule's reach is seen before it is saved rather than after it runs.
 * Below the rules, chats can be archived or deleted by hand, the chat
 * database shrunk, and stored files no chat shows deleted.
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AlertTriangle, Archive, ExternalLink, Plus, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';

import Link from 'next/link';

import { SettingRow, SettingsGroup } from '@/components/settings/section';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ReadFailed } from '@/components/ui/read-failed';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tooltip } from '@/components/ui/tooltip';
import {
  storage,
  type ArchivedChat,
  type StorageChat,
  type StorageEffect,
  type StoragePartId,
  type StorageRule,
  type StorageRules,
  type StorageRunReport,
  type StorageUsage,
} from '@/lib/api';
import { getProjects } from '@/lib/db';
import { cn } from '@/lib/utils';
import type { Project } from '@/types';
import {
  AGE_LABELS,
  PART_LABELS,
  TARGETS,
  UNITS,
  UNIT_DAYS,
  bytesWords,
  conflicts,
  count,
  newRuleId,
  ruleTitle,
} from '@/workbench/storage-rules';

const PART_COLORS: Record<StoragePartId, string> = {
  chats: 'hsl(var(--chart-1))',
  archive: 'hsl(var(--chart-1) / 0.5)',
  media: 'hsl(var(--chart-2))',
  claude: 'hsl(var(--chart-3))',
  codex: 'hsl(var(--chart-4))',
  search: 'hsl(var(--chart-5))',
  skills: 'hsl(var(--info))',
  browser: 'hsl(var(--warning))',
  backups: 'hsl(var(--success))',
  other: 'hsl(var(--muted-foreground) / 0.45)',
};

const ALL_PROJECTS = '__all__';
const LONGEST_DAYS = 3650;

/** ["2 chats", "1 image", "1 file"] → "2 chats, 1 image and 1 file". */
function listWords(parts: string[]): string {
  return parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function valid(rule: StorageRule): boolean {
  return Number.isInteger(rule.amount) && rule.amount >= 1 && rule.amount * UNIT_DAYS[rule.unit] <= LONGEST_DAYS;
}

export function StorageSettings() {
  // Bumped after anything is cleared, so every list here is read again.
  const [ran, setRan] = useState(0);
  const changed = useCallback(() => setRan((n) => n + 1), []);
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => {
    let gone = false;
    getProjects()
      .then((list) => !gone && setProjects(list))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, []);
  return (
    <div data-testid="storage-settings">
      <UsageSection ran={ran} onChanged={changed} />
      <RulesSection projects={projects} onRan={changed} />
      <LargestChats ran={ran} projects={projects} onChanged={changed} />
      <ArchivedChats ran={ran} projects={projects} onChanged={changed} />
    </div>
  );
}

function projectName(projects: Project[], id: string): string {
  return projects.find((p) => p.id === id)?.name ?? 'Unknown project';
}

function dateWords(at: string): string {
  return new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

// ===== Usage =====

function UsageSection({ ran, onChanged }: { ran: number; onChanged: () => void }) {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [unread, setUnread] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (fresh: boolean) => {
    setLoading(true);
    setUnread(null);
    try {
      setUsage(await storage.usage(fresh));
    } catch (e) {
      setUnread(message(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(ran > 0);
  }, [load, ran]);

  // While the chats are first being measured, follow along.
  const measuring = usage !== null && !usage.index.ready;
  useEffect(() => {
    if (!measuring) return;
    const timer = window.setTimeout(() => void load(false), 3000);
    return () => window.clearTimeout(timer);
  }, [measuring, usage, load]);

  if (unread && !usage) {
    return <ReadFailed data-testid="storage-usage-error" what="Couldn’t load storage usage." why={unread} onRetry={() => void load(true)} />;
  }

  const refresh = (
    <Button variant="outline" size="sm" onClick={() => void load(true)} disabled={loading} data-testid="storage-refresh">
      {loading ? <Spinner size="sm" /> : <RefreshCw />}
      Refresh
    </Button>
  );

  return (
    <>
      <SettingsGroup title="Usage" actions={refresh} data-testid="storage-usage">
        {usage ? <UsageBreakdown usage={usage} /> : <div className="flex h-40 items-center justify-center"><Spinner /></div>}
      </SettingsGroup>
      {usage && <ChatAges usage={usage} />}
      {usage && <FreeUpSpace usage={usage} onChanged={onChanged} />}
    </>
  );
}

function UsageBreakdown({ usage }: { usage: StorageUsage }) {
  const parts = usage.parts.filter((p) => p.bytes > 0).sort((a, b) => b.bytes - a.bytes);
  const total = Math.max(usage.total, 1);
  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="text-3xl font-semibold tabular-nums text-t-primary" data-testid="storage-total">
            {bytesWords(usage.total)}
          </div>
          <div className="text-sm text-t-tertiary">Used by Atelier</div>
        </div>
        {usage.disk && (
          <div className="text-right text-sm text-t-tertiary" data-testid="storage-disk">
            {bytesWords(usage.disk.free)} free of {bytesWords(usage.disk.total)}
          </div>
        )}
      </div>

      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label="Storage by type">
        {parts.map((part) => (
          <Tooltip key={part.id} label={`${PART_LABELS[part.id]}: ${bytesWords(part.bytes)}`}>
            <div
              className="h-full border-r border-background/60 last:border-r-0"
              style={{ width: `${Math.max((part.bytes / total) * 100, 0.6)}%`, background: PART_COLORS[part.id] }}
            />
          </Tooltip>
        ))}
      </div>

      <ul className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
        {parts.map((part) => (
          <li key={part.id} className="flex items-center gap-2 py-1 text-sm" data-testid={`storage-part-${part.id}`}>
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: PART_COLORS[part.id] }} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-t-secondary">
              {PART_LABELS[part.id]}
              {part.id === 'chats' && (usage.unusedChatBytes ?? 0) > 0 && (
                <Tooltip label="Space from deleted chats. New chats reuse it.">
                  <span className="ml-1.5 text-xs text-t-muted">({bytesWords(usage.unusedChatBytes!)} unused)</span>
                </Tooltip>
              )}
            </span>
            <span className="tabular-nums text-t-primary">{bytesWords(part.bytes)}</span>
            <span className="w-11 text-right text-xs tabular-nums text-t-muted">{Math.round((part.bytes / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChatAges({ usage }: { usage: StorageUsage }) {
  const largest = Math.max(1, ...usage.ages.map((a) => a.bytes + a.media));
  return (
    <SettingsGroup
      title="Chats"
      description={usage.index.ready ? count(usage.chats, 'chat') : undefined}
      data-testid="storage-chats"
    >
      {!usage.index.ready && (
        <div className="flex items-center gap-2 px-4 py-2.5 text-sm text-t-tertiary" data-testid="storage-measuring">
          <Spinner size="sm" />
          Measuring chats… {usage.index.measured.toLocaleString()} of {usage.index.chats.toLocaleString()}
        </div>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-t-muted">
            <th className="px-4 py-2 font-medium">Last used</th>
            <th className="px-2 py-2 text-right font-medium">Chats</th>
            <th className="px-2 py-2 text-right font-medium">Size</th>
            <th className="px-2 py-2 text-right font-medium">Images and files</th>
            <th className="hidden w-1/4 px-4 py-2 sm:table-cell" aria-hidden />
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40">
          {usage.ages.map((age) => (
            <tr key={age.id} data-testid={`storage-age-${age.id}`} className={cn(age.chats === 0 && 'text-t-muted')}>
              <td className="px-4 py-2 text-t-secondary">{AGE_LABELS[age.id]}</td>
              <td className="px-2 py-2 text-right tabular-nums">{age.chats.toLocaleString()}</td>
              <td className="px-2 py-2 text-right tabular-nums">{age.chats ? bytesWords(age.bytes) : '—'}</td>
              <td className="px-2 py-2 text-right tabular-nums">{age.media ? bytesWords(age.media) : '—'}</td>
              <td className="hidden px-4 py-2 sm:table-cell">
                <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
                  <div style={{ width: `${(age.bytes / largest) * 100}%`, background: PART_COLORS.chats }} />
                  <div style={{ width: `${(age.media / largest) * 100}%`, background: PART_COLORS.media }} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </SettingsGroup>
  );
}

// ===== Rules =====

function RulesSection({ projects, onRan }: { projects: Project[]; onRan: () => void }) {
  const [held, setHeld] = useState<StorageRules | null>(null);
  const [draft, setDraft] = useState<StorageRule[]>([]);
  const [keepLinked, setKeepLinked] = useState(true);
  const [unread, setUnread] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [effects, setEffects] = useState<Map<string, StorageEffect> | null>(null);
  const [counting, setCounting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let gone = false;
    setUnread(null);
    storage
      .rules()
      .then((it) => {
        if (gone) return;
        setHeld(it);
        setDraft(it.rules);
        setKeepLinked(it.keepLinked);
      })
      .catch((e) => !gone && setUnread(message(e)));
    return () => {
      gone = true;
    };
  }, [attempt]);

  const dirty = held !== null && (JSON.stringify(held.rules) !== JSON.stringify(draft) || held.keepLinked !== keepLinked);
  const allValid = draft.every(valid);
  const found = useMemo(() => conflicts(draft), [draft]);

  // What the draft would delete now, asked again a moment after each change.
  const asked = useRef(0);
  useEffect(() => {
    if (!held || !allValid) return;
    const ask = ++asked.current;
    setCounting(true);
    const timer = window.setTimeout(() => {
      storage
        .preview(draft, keepLinked)
        .then((list) => ask === asked.current && setEffects(new Map(list.map((e) => [e.id, e]))))
        .catch(() => ask === asked.current && setEffects(null))
        .finally(() => ask === asked.current && setCounting(false));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [draft, keepLinked, held, allValid]);

  const change = (id: string, patch: Partial<StorageRule>) =>
    setDraft((rules) => rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));

  const add = () =>
    setDraft((rules) => [...rules, { id: newRuleId(), enabled: true, amount: 3, unit: 'months', delete: 'chats', projectId: null }]);

  const save = async () => {
    setRefused(null);
    setSaving(true);
    try {
      const saved = await storage.saveRules(draft, keepLinked);
      setHeld(saved);
      setDraft(saved.rules);
      setKeepLinked(saved.keepLinked);
    } catch (e) {
      setRefused(message(e));
    } finally {
      setSaving(false);
    }
  };

  const run = async () => {
    setRefused(null);
    setRunning(true);
    try {
      const report = await storage.run();
      setHeld((h) => (h ? { ...h, lastRun: report } : h));
      setDraft((d) => [...d]);
      onRan();
    } catch (e) {
      setRefused(message(e));
    } finally {
      setRunning(false);
    }
  };

  if (unread) {
    return <ReadFailed data-testid="storage-rules-error" what="Couldn’t load cleanup rules." why={unread} onRetry={() => setAttempt((n) => n + 1)} />;
  }
  if (!held) return null;

  const enabled = draft.filter((r) => r.enabled);
  const totals = enabled.reduce(
    (sum, rule) => {
      const effect = effects?.get(rule.id);
      if (!effect) return sum;
      if (rule.delete === 'chats') sum.chats += effect.chats;
      else if (rule.delete === 'archive') sum.archived += effect.chats;
      else if (rule.delete === 'images') sum.images += effect.items;
      else if (rule.delete === 'files') sum.files += effect.items;
      else sum.trimmed += effect.items;
      sum.bytes += effect.bytes;
      return sum;
    },
    { chats: 0, archived: 0, images: 0, files: 0, trimmed: 0, bytes: 0 },
  );
  const deletes = [
    totals.chats && count(totals.chats, 'chat'),
    totals.images && count(totals.images, 'image'),
    totals.files && count(totals.files, 'file'),
  ].filter((part): part is string => Boolean(part));
  const steps = [
    deletes.length > 0 && `deletes ${listWords(deletes)}`,
    totals.archived > 0 && `archives ${count(totals.archived, 'chat')}`,
    totals.trimmed > 0 && `trims ${count(totals.trimmed, 'tool output', 'tool outputs')}`,
  ].filter((part): part is string => Boolean(part));
  const nothing = steps.length === 0;
  const lasting = deletes.length > 0 || totals.trimmed > 0;

  const actions = (
    <div className="flex items-center gap-2">
      <Tooltip label={dirty ? 'Save changes first' : enabled.length === 0 ? 'No rules enabled' : 'Run enabled rules now'}>
        <span>
          <Button
            variant="outline"
            size="sm"
            data-testid="storage-run"
            disabled={dirty || enabled.length === 0 || running}
            onClick={() => setConfirming(true)}
          >
            {running && <Spinner size="sm" />}
            {running ? 'Running…' : 'Run now'}
          </Button>
        </span>
      </Tooltip>
      <Button variant="outline" size="sm" data-testid="storage-add-rule" onClick={add} disabled={draft.length >= 20}>
        <Plus />
        Add rule
      </Button>
    </div>
  );

  return (
    <SettingsGroup
      title="Cleanup rules"
      description="Enabled rules run once a day."
      actions={actions}
      data-testid="storage-rules"
    >
      <SettingRow
        label="Keep chats linked to open cards"
        description="Rules skip a chat while a card it’s linked to is open."
        htmlFor="storage-keep-linked"
      >
        <Switch id="storage-keep-linked" checked={keepLinked} onCheckedChange={setKeepLinked} data-testid="storage-keep-linked" />
      </SettingRow>
      {draft.length === 0 && (
        <div className="px-4 py-8 text-center" data-testid="storage-rules-empty">
          <div className="text-sm font-medium text-t-secondary">No rules yet</div>
          <div className="mt-1 text-xs text-t-muted">Add a rule to clear old chats automatically.</div>
        </div>
      )}
      {draft.map((rule, index) => (
        <RuleCard
          key={rule.id}
          rule={rule}
          index={index}
          projects={projects}
          effect={rule.enabled && valid(rule) ? effects?.get(rule.id) : undefined}
          counting={counting}
          conflict={found.get(rule.id)?.message}
          onChange={(patch) => change(rule.id, patch)}
          onDelete={() => setDraft((rules) => rules.filter((r) => r.id !== rule.id))}
        />
      ))}

      {held.lastRun && !dirty && <LastRun run={held.lastRun} />}

      {refused && (
        <p data-testid="storage-refused" className="px-4 py-2 text-sm text-danger" role="alert">
          {refused}
        </p>
      )}

      {dirty && (
        <div className="flex items-center justify-between gap-3 bg-muted/30 px-4 py-2.5" data-testid="storage-unsaved">
          <span className="text-sm text-t-tertiary">{allValid ? 'Unsaved changes' : 'Fix the highlighted fields to save'}</span>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(held.rules);
                setKeepLinked(held.keepLinked);
              }}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving || !allValid} data-testid="storage-save">
              {saving && <Spinner size="sm" />}
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent data-testid="storage-run-confirm">
          <AlertDialogTitle>Run cleanup now?</AlertDialogTitle>
          <AlertDialogDescription>
            {nothing
              ? 'No chats match the enabled rules right now.'
              : `This ${listWords(steps)}${totals.bytes ? `, and frees about ${bytesWords(totals.bytes)}` : ''}.${
                  lasting ? ' You can’t undo this.' : ' You can restore archived chats later.'
                }`}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="storage-run-confirmed"
              className={cn(lasting && 'bg-destructive text-destructive-foreground hover:bg-destructive/90')}
              onClick={() => void run()}
            >
              Run now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsGroup>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn('flex min-w-0 flex-col gap-1', className)}>
      <span className="text-xs font-medium text-t-tertiary">{label}</span>
      {children}
    </label>
  );
}

function RuleCard({
  rule,
  index,
  projects,
  effect,
  counting,
  conflict,
  onChange,
  onDelete,
}: {
  rule: StorageRule;
  index: number;
  projects: Project[];
  effect?: StorageEffect;
  counting: boolean;
  conflict?: string;
  onChange: (patch: Partial<StorageRule>) => void;
  onDelete: () => void;
}) {
  const ok = valid(rule);
  const [amount, setAmount] = useState(String(rule.amount));
  useEffect(() => setAmount(String(rule.amount)), [rule.amount]);
  const projectName = rule.projectId ? (projects.find((p) => p.id === rule.projectId)?.name ?? 'Unknown project') : null;

  return (
    <div className={cn('space-y-3 p-4', !rule.enabled && 'bg-muted/20')} data-testid="storage-rule">
      <div className="flex items-center gap-3">
        <Switch
          checked={rule.enabled}
          onCheckedChange={(on) => onChange({ enabled: on })}
          aria-label={`Enable rule ${index + 1}`}
          data-testid="storage-rule-enabled"
        />
        <div className="min-w-0 flex-1">
          <div className={cn('truncate text-sm font-medium', rule.enabled ? 'text-t-primary' : 'text-t-muted')} data-testid="storage-rule-title">
            {ruleTitle(rule)}
            {projectName && <span className="font-normal text-t-tertiary"> · {projectName}</span>}
          </div>
          <div className="text-xs text-t-muted">Rule {index + 1}{!rule.enabled && ' · Disabled'}</div>
        </div>
        <Tooltip label="Delete rule">
          <Button variant="ghost" size="icon" aria-label={`Delete rule ${index + 1}`} onClick={onDelete} data-testid="storage-rule-delete">
            <Trash2 />
          </Button>
        </Tooltip>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr]">
        <Field label="Action">
          <Select value={rule.delete} onValueChange={(value) => onChange({ delete: value as StorageRule['delete'] })}>
            <SelectTrigger aria-label="Action" data-testid="storage-rule-target">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TARGETS.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Older than">
          <div className="flex gap-2">
            <Input
              type="number"
              min={1}
              max={Math.floor(LONGEST_DAYS / UNIT_DAYS[rule.unit])}
              inputMode="numeric"
              aria-label="Age"
              aria-invalid={!ok}
              data-testid="storage-rule-amount"
              className={cn('w-20 tabular-nums', !ok && 'border-danger focus-visible:ring-danger')}
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                const n = Number(e.target.value);
                onChange({ amount: e.target.value.trim() === '' || !Number.isFinite(n) ? 0 : n });
              }}
            />
            <Select value={rule.unit} onValueChange={(value) => onChange({ unit: value as StorageRule['unit'] })}>
              <SelectTrigger aria-label="Unit" className="w-28" data-testid="storage-rule-unit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UNITS.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </Field>
        <Field label="Project">
          <Select
            value={rule.projectId ?? ALL_PROJECTS}
            onValueChange={(value) => onChange({ projectId: value === ALL_PROJECTS ? null : value })}
          >
            <SelectTrigger aria-label="Project" data-testid="storage-rule-project">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
              {rule.projectId && !projects.some((p) => p.id === rule.projectId) && (
                <SelectItem value={rule.projectId}>Unknown project</SelectItem>
              )}
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <p className="text-xs text-t-muted">{TARGETS.find((t) => t.id === rule.delete)?.hint}</p>
      {!ok && (
        <p className="text-xs text-danger" role="alert">
          Enter an age between 1 day and 10 years.
        </p>
      )}
      {ok && conflict && (
        <div className="flex items-center gap-1.5 text-xs text-warning" data-testid="storage-rule-conflict">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          {conflict}
        </div>
      )}
      {ok && rule.enabled && !conflict && <EffectLine rule={rule} effect={effect} counting={counting} />}
    </div>
  );
}

function EffectLine({ rule, effect, counting }: { rule: StorageRule; effect?: StorageEffect; counting: boolean }) {
  if (!effect) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-t-muted">
        {counting && <Spinner size="2xs" />}
        {counting ? 'Counting…' : ''}
      </div>
    );
  }
  const whole = rule.delete === 'chats' || rule.delete === 'archive';
  const item = rule.delete === 'images' ? 'image' : rule.delete === 'files' ? 'file' : 'tool output';
  const what = whole ? count(effect.chats, 'chat') : `${count(effect.items, item)} in ${count(effect.chats, 'chat')}`;
  const none = whole ? effect.chats === 0 : effect.items === 0;
  return (
    <div className="flex items-center gap-1.5 text-xs text-t-tertiary" data-testid="storage-rule-effect">
      {none ? 'No matches right now' : `Matches ${what}${effect.bytes ? ` · Frees ${bytesWords(effect.bytes)}` : ''}`}
      {counting && <Spinner size="2xs" />}
    </div>
  );
}

function LastRun({ run }: { run: StorageRunReport }) {
  const when = new Date(run.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const deleted = [
    run.chats && count(run.chats, 'chat'),
    run.images && count(run.images, 'image'),
    run.files && count(run.files, 'file'),
  ].filter((part): part is string => Boolean(part));
  const done = [
    deleted.length > 0 && `Deleted ${listWords(deleted)}`,
    run.archived && `Archived ${count(run.archived, 'chat')}`,
    run.trimmed && `Trimmed ${count(run.trimmed, 'tool output', 'tool outputs')}`,
  ].filter((part): part is string => Boolean(part));
  return (
    <div className="space-y-0.5 px-4 py-2.5 text-xs text-t-tertiary" data-testid="storage-last-run">
      <div>
        Last run {when} · {done.length ? done.join(' · ') : 'Nothing cleared'}
        {run.bytes > 0 && ` · Freed ${bytesWords(run.bytes)}`}
      </div>
      {run.failed > 0 && (
        <div className="text-warning">
          Couldn’t clear {count(run.failed, 'chat')}.{run.error ? ` ${run.error}` : ''}
        </div>
      )}
      {run.remaining > 0 && <div>{count(run.remaining, 'more chat', 'more chats')} will be cleared on the next run.</div>}
    </div>
  );
}

// ===== By hand =====

/** One question before a step that clears something. */
interface Asking {
  title: string;
  body: string;
  action: string;
  /** Deletes something for good, so the button is red. */
  lasting: boolean;
  go: () => Promise<void>;
}

function Confirm({ asking, onClose }: { asking: Asking | null; onClose: () => void }) {
  return (
    <AlertDialog open={asking !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent data-testid="storage-confirm">
        <AlertDialogTitle>{asking?.title}</AlertDialogTitle>
        <AlertDialogDescription>{asking?.body}</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            data-testid="storage-confirmed"
            className={cn(asking?.lasting && 'bg-destructive text-destructive-foreground hover:bg-destructive/90')}
            onClick={() => {
              const go = asking?.go;
              onClose();
              void go?.();
            }}
          >
            {asking?.action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Runs one step at a time, holding which one is busy and why the last one failed. */
function useStep(onChanged: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const step = useCallback(
    async (key: string, work: () => Promise<unknown>) => {
      setBusy(key);
      setRefused(null);
      try {
        await work();
        onChanged();
      } catch (e) {
        setRefused(message(e));
      } finally {
        setBusy(null);
      }
    },
    [onChanged],
  );
  return { busy, refused, step };
}

function Refused({ refused }: { refused: string | null }) {
  if (!refused) return null;
  return (
    <p data-testid="storage-step-refused" className="px-4 py-2 text-sm text-danger" role="alert">
      {refused}
    </p>
  );
}

function FreeUpSpace({ usage, onChanged }: { usage: StorageUsage; onChanged: () => void }) {
  const { busy, refused, step } = useStep(onChanged);
  const [asking, setAsking] = useState<Asking | null>(null);
  const unused = usage.unusedFiles;
  const spare = usage.unusedChatBytes ?? 0;

  const deleteUnused = () =>
    setAsking({
      title: 'Delete unused images and files?',
      body: `This deletes ${count(unused.files, 'file')} that no chat or archive shows, and frees about ${bytesWords(unused.bytes)}. You can’t undo this.`,
      action: 'Delete',
      lasting: true,
      go: () => step('unused', () => storage.deleteUnused()),
    });
  const shrink = () =>
    setAsking({
      title: 'Shrink chat database?',
      body: `This returns about ${bytesWords(spare)} of unused space to the disk. Chats can’t save while it runs, which can take a few minutes. After this, unused space is returned automatically.`,
      action: 'Shrink',
      lasting: false,
      go: () => step('shrink', () => storage.compact()),
    });

  return (
    <SettingsGroup title="Free up space" data-testid="storage-free">
      <SettingRow
        label="Unused images and files"
        description={
          unused.files > 0
            ? `${count(unused.files, 'file')} no chat shows · ${bytesWords(unused.bytes)}`
            : 'Every stored image and file is shown in a chat.'
        }
        data-testid="storage-unused"
      >
        <Tooltip label={unused.allowed ? 'Delete unused images and files' : 'Files can be deleted once the installed app is updated and running.'}>
          <span>
            <Button
              variant="outline"
              size="sm"
              data-testid="storage-delete-unused"
              disabled={!unused.allowed || unused.files === 0 || busy !== null}
              onClick={deleteUnused}
            >
              {busy === 'unused' ? <Spinner size="sm" /> : <Trash2 />}
              Delete
            </Button>
          </span>
        </Tooltip>
      </SettingRow>
      <SettingRow
        label="Chat database"
        description={
          usage.reclaims
            ? 'Space from deleted chats is returned to the disk automatically.'
            : spare > 0
              ? `${bytesWords(spare)} unused. Shrink the database to return it to the disk.`
              : 'Shrink the database once to return space from deleted chats automatically.'
        }
        data-testid="storage-database"
      >
        {!usage.reclaims && (
          <Button variant="outline" size="sm" data-testid="storage-shrink" disabled={busy !== null} onClick={shrink}>
            {busy === 'shrink' && <Spinner size="sm" />}
            {busy === 'shrink' ? 'Shrinking…' : 'Shrink'}
          </Button>
        )}
      </SettingRow>
      <Refused refused={refused} />
      <Confirm asking={asking} onClose={() => setAsking(null)} />
    </SettingsGroup>
  );
}

function LargestChats({ ran, projects, onChanged }: { ran: number; projects: Project[]; onChanged: () => void }) {
  const [chats, setChats] = useState<StorageChat[] | null>(null);
  const [ready, setReady] = useState(true);
  const [unread, setUnread] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [asking, setAsking] = useState<Asking | null>(null);
  const { busy, refused, step } = useStep(onChanged);

  useEffect(() => {
    let gone = false;
    setUnread(null);
    storage
      .largest(20)
      .then((it) => {
        if (gone) return;
        setChats(it.chats);
        setReady(it.ready);
      })
      .catch((e) => !gone && setUnread(message(e)));
    return () => {
      gone = true;
    };
  }, [ran, attempt]);

  if (unread && !chats) {
    return <ReadFailed data-testid="storage-largest-error" what="Couldn’t load the largest chats." why={unread} onRetry={() => setAttempt((n) => n + 1)} />;
  }
  if (!chats) return null;

  const clear = (chat: StorageChat, archive: boolean) => {
    const name = chat.title || 'Untitled chat';
    setAsking(
      archive
        ? {
            title: 'Archive chat?',
            body: `“${name}” moves to a compressed archive and leaves the chat list. You can restore it later.`,
            action: 'Archive',
            lasting: false,
            go: () => step(chat.id, () => storage.clearChats([chat.id], 'archive').then(failedAny)),
          }
        : {
            title: 'Delete chat?',
            body: `“${name}” and the images and files only it shows are deleted. You can’t undo this.`,
            action: 'Delete',
            lasting: true,
            go: () => step(chat.id, () => storage.clearChats([chat.id], 'delete').then(failedAny)),
          },
    );
  };

  return (
    <SettingsGroup
      title="Largest chats"
      description={ready ? undefined : 'Still measuring chats. Sizes may change.'}
      data-testid="storage-largest"
    >
      {chats.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-t-muted">No chats</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-t-muted">
              <th className="px-4 py-2 font-medium">Chat</th>
              <th className="hidden px-2 py-2 font-medium sm:table-cell">Last used</th>
              <th className="px-2 py-2 text-right font-medium">Size</th>
              <th className="px-4 py-2" aria-label="Actions" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {chats.map((chat) => {
              const name = chat.title || 'Untitled chat';
              const blocked = chat.active ? 'Stop the chat first' : null;
              return (
                <tr key={chat.id} data-testid="storage-largest-chat">
                  <td className="max-w-0 px-4 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Link
                        href={`/project?id=${encodeURIComponent(chat.projectId)}&tab=chat&chat=${encodeURIComponent(chat.id)}`}
                        className="truncate text-t-primary hover:underline"
                      >
                        {name}
                      </Link>
                      {chat.kept && (
                        <Badge variant="info" appearance="light" size="sm" className="shrink-0">
                          Open card
                        </Badge>
                      )}
                      {chat.active && (
                        <Badge variant="success" appearance="light" size="sm" className="shrink-0">
                          Running
                        </Badge>
                      )}
                    </div>
                    <div className="truncate text-xs text-t-muted">{projectName(projects, chat.projectId)}</div>
                  </td>
                  <td className="hidden whitespace-nowrap px-2 py-2 text-t-tertiary sm:table-cell">{dateWords(chat.lastAt)}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{bytesWords(chat.bytes + chat.media)}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    {busy === chat.id ? (
                      <Spinner size="sm" />
                    ) : (
                      <div className="flex justify-end gap-1">
                        <Tooltip label="Open chat">
                          <Button variant="ghost" size="icon" asChild aria-label={`Open ${name}`}>
                            <Link href={`/project?id=${encodeURIComponent(chat.projectId)}&tab=chat&chat=${encodeURIComponent(chat.id)}`}>
                              <ExternalLink />
                            </Link>
                          </Button>
                        </Tooltip>
                        <Tooltip label={blocked ?? 'Archive chat'}>
                          <span>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Archive ${name}`}
                              data-testid="storage-chat-archive"
                              disabled={chat.active || busy !== null}
                              onClick={() => clear(chat, true)}
                            >
                              <Archive />
                            </Button>
                          </span>
                        </Tooltip>
                        <Tooltip label={blocked ?? 'Delete chat'}>
                          <span>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Delete ${name}`}
                              data-testid="storage-chat-delete"
                              disabled={chat.active || busy !== null}
                              onClick={() => clear(chat, false)}
                            >
                              <Trash2 />
                            </Button>
                          </span>
                        </Tooltip>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <Refused refused={refused} />
      <Confirm asking={asking} onClose={() => setAsking(null)} />
    </SettingsGroup>
  );
}

/** A by-hand clear that cleared nothing says why. */
function failedAny(done: { done: number; failed: number; error: string | null }) {
  if (done.failed > 0) throw new Error(done.error ?? 'Couldn’t clear the chat.');
}

function ArchivedChats({ ran, projects, onChanged }: { ran: number; projects: Project[]; onChanged: () => void }) {
  const [chats, setChats] = useState<ArchivedChat[] | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const { busy, refused, step } = useStep(onChanged);

  useEffect(() => {
    let gone = false;
    storage
      .archived()
      .then((list) => !gone && setChats(list))
      .catch(() => !gone && setChats([]));
    return () => {
      gone = true;
    };
  }, [ran]);

  if (!chats || chats.length === 0) return null;

  return (
    <SettingsGroup title="Archived chats" description={count(chats.length, 'chat')} data-testid="storage-archived">
      {chats.map((chat) => {
        const name = chat.title || 'Untitled chat';
        return (
          <SettingRow
            key={chat.id}
            label={name}
            description={`${projectName(projects, chat.projectId)} · Archived ${dateWords(chat.archivedAt)} · ${bytesWords(chat.size)}`}
            data-testid="storage-archived-chat"
          >
            {busy === chat.id ? (
              <Spinner size="sm" />
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="storage-archived-restore"
                  disabled={busy !== null}
                  onClick={() => void step(chat.id, () => storage.restore(chat.id))}
                >
                  <RotateCcw />
                  Restore
                </Button>
                <Tooltip label="Delete archive">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${name}`}
                    data-testid="storage-archived-delete"
                    disabled={busy !== null}
                    onClick={() =>
                      setAsking({
                        title: 'Delete archived chat?',
                        body: `“${name}” and the images and files only it shows are deleted. You can’t undo this.`,
                        action: 'Delete',
                        lasting: true,
                        go: () => step(chat.id, () => storage.deleteArchive(chat.id)),
                      })
                    }
                  >
                    <Trash2 />
                  </Button>
                </Tooltip>
              </>
            )}
          </SettingRow>
        );
      })}
      <Refused refused={refused} />
      <Confirm asking={asking} onClose={() => setAsking(null)} />
    </SettingsGroup>
  );
}
