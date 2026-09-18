/**
 * A provider's settings, drawn from the schema: one row per key, the control
 * that edits it, and a word on where the value in force comes from when that
 * is not the file being edited.
 *
 * Every change is written at once, to one file — the account's own, or the
 * project's shared or local file — and the screen redraws from what the server
 * read back, so what is shown is always what is on disk (bw-2t1c.4, .5).
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { Loader2 } from 'lucide-react';

import { pagesFor, type Brand, type Control, type SettingDef } from '@/components/settings/provider-schema';
import {
  effective,
  getPath,
  layerName,
  readSettings,
  writeSettings,
  type Layer,
  type Scope,
  type SettingsView,
} from '@/components/settings/provider-settings-api';
import { SettingRow, SettingsGroup } from '@/components/settings/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel } from '@/components/ui/panel';
import { ReadFailed } from '@/components/ui/read-failed';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { sendCommand } from '@/workbench/use-session';

const UNSET = '__unset__';

function said(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A control's own idea of the value, as text the reader can edit. */
function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function linesOf(value: unknown): string {
  return Array.isArray(value) ? value.map(asText).join('\n') : '';
}

function pairsOf(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `${k}=${asText(v)}`)
    .join('\n');
}

/** The names of the scope's own output styles, without `.md`. */
function useOutputStyles(scope: Scope, wanted: boolean): string[] {
  const [names, setNames] = useState<string[]>([]);
  const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    const where = scope.kind === 'account' ? { profileId: scope.profileId } : { projectPath: scope.projectPath };
    sendCommand<{ files: { provider: string; category: string; name: string }[] }>({ type: 'agent-files.list', ...where })
      .then(({ files }) => {
        if (!live) return;
        setNames(files.filter((f) => f.provider === 'claude' && f.category === 'output-styles').map((f) => f.name.replace(/\.md$/, '')));
      })
      .catch(() => live && setNames([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, wanted]);
  return names;
}

function ChoiceControl({
  control,
  value,
  onChange,
  id,
  scope,
}: {
  control: Extract<Control, { kind: 'choice' }>;
  value: unknown;
  onChange: (v: unknown) => void;
  id: string;
  scope: Scope;
}) {
  const text = asText(value);
  const own = useOutputStyles(scope, control.plus === 'outputStyles');
  // A value the provider ignores from this kind of file is not offered here,
  // so the reader is never handed a choice that does nothing (bw-6ecp.10).
  const honoured = control.choices.filter((c) => !c.scopes || c.scopes.includes(scope.kind));
  const choices = [...honoured, ...own.filter((name) => !control.choices.some((c) => c.value === name)).map((name) => ({ value: name, label: name, hint: 'Yours' }))];
  const listed = choices.some((c) => c.value === text);
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState(text);
  const [replacing, setReplacing] = useState(false);
  useEffect(() => setDraft(text), [text]);
  // The key's other shape. Drawing the select over it would read the table as
  // unset and then write a string in its place, losing what the file said
  // (bw-6ecp.13). So it is shown as it stands, and replacing it is a click.
  const table = control.table && value !== null && typeof value === 'object' ? value : null;
  if (table && !replacing) {
    return (
      <div className="flex items-center gap-2">
        <Tooltip label={JSON.stringify(table)}>
          <Badge variant="secondary" size="sm" data-testid={`${id}-table`}>
            {control.table} — set in the file
          </Badge>
        </Tooltip>
        <Button variant="outline" size="sm" onClick={() => setReplacing(true)} data-testid={`${id}-replace`}>
          Replace…
        </Button>
      </div>
    );
  }
  if (control.free && (custom || (text && !listed))) {
    return (
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft.trim() === '') {
              onChange(null);
              setCustom(false);
            } else if (draft !== text) onChange(draft.trim());
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          className="w-56 font-mono text-xs"
          placeholder="another value"
        />
      </div>
    );
  }
  return (
    <Select
      value={text === '' ? UNSET : text}
      onValueChange={(v) => {
        if (v === UNSET) onChange(null);
        else if (v === '__other__') setCustom(true);
        else onChange(v);
      }}
    >
      <SelectTrigger id={id} className="w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNSET}>Not set</SelectItem>
        {choices.map((c) => (
          <SelectItem key={c.value} value={c.value}>
            {c.label}
            {c.hint && <span className="ml-2 text-xs text-t-muted">{c.hint}</span>}
          </SelectItem>
        ))}
        {control.free && <SelectItem value="__other__">Another value…</SelectItem>}
      </SelectContent>
    </Select>
  );
}

function ToggleControl({ value, onChange, id }: { value: unknown; onChange: (v: unknown) => void; id: string }) {
  const text = value === true ? 'true' : value === false ? 'false' : UNSET;
  return (
    <Select value={text} onValueChange={(v) => onChange(v === UNSET ? null : v === 'true')}>
      <SelectTrigger id={id} className="w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNSET}>Not set</SelectItem>
        <SelectItem value="true">On</SelectItem>
        <SelectItem value="false">Off</SelectItem>
      </SelectContent>
    </Select>
  );
}

function TextControl({
  control,
  value,
  onChange,
  id,
}: {
  control: Extract<Control, { kind: 'text' | 'number' }>;
  value: unknown;
  onChange: (v: unknown) => void;
  id: string;
}) {
  const text = asText(value);
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === text) return;
    if (trimmed === '') onChange(null);
    else if (control.kind === 'number') {
      const n = Number(trimmed);
      if (Number.isFinite(n)) onChange(n);
      else setDraft(text);
    } else onChange(draft);
  };
  return (
    <Input
      id={id}
      type={control.kind === 'number' ? 'number' : 'text'}
      min={control.kind === 'number' ? control.min : undefined}
      max={control.kind === 'number' ? control.max : undefined}
      step={control.kind === 'number' ? control.step : undefined}
      value={draft}
      placeholder={control.kind === 'text' ? control.placeholder : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      className={cn('w-56', (control.kind === 'number' || (control.kind === 'text' && control.mono)) && 'font-mono text-xs')}
    />
  );
}

function LinesControl({
  value,
  onChange,
  id,
  placeholder,
  pairs,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  id: string;
  placeholder?: string;
  /** `KEY=value` rows making an object, rather than one string per line. */
  pairs?: boolean;
}) {
  const text = pairs ? pairsOf(value) : linesOf(value);
  const [draft, setDraft] = useState(text);
  const [wrong, setWrong] = useState<string | null>(null);
  useEffect(() => setDraft(text), [text]);
  const commit = () => {
    if (draft.trim() === text.trim()) return;
    const rows = draft
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (rows.length === 0) return onChange(null);
    if (!pairs) return onChange(rows);
    const map: Record<string, string> = {};
    const bad: string[] = [];
    for (const row of rows) {
      const at = row.indexOf('=');
      if (at <= 0) bad.push(row);
      else map[row.slice(0, at).trim()] = row.slice(at + 1);
    }
    // A typo used to be swallowed: the line was dropped without a word, and a
    // box of nothing but typos wrote `{}` over every variable already there
    // (bw-6ecp.11). Nothing is written until every line is a pair.
    if (bad.length > 0) {
      setWrong(`${bad.length === 1 ? 'This line is' : 'These lines are'} not NAME=value: ${bad.join(', ')}`);
      return;
    }
    setWrong(null);
    onChange(map);
  };
  return (
    <div className="w-full space-y-1">
      <Textarea
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        placeholder={pairs ? 'NAME=value' : placeholder}
        rows={Math.min(8, Math.max(2, draft.split('\n').length))}
        className="w-full font-mono text-xs"
        spellCheck={false}
      />
      {wrong && (
        <p className="text-xs text-danger" role="alert" data-testid={`${id}-wrong`}>
          {wrong}
        </p>
      )}
    </div>
  );
}

function SettingControl({
  def,
  value,
  onChange,
  id,
  scope,
}: {
  def: SettingDef;
  value: unknown;
  onChange: (v: unknown) => void;
  id: string;
  scope: Scope;
}) {
  switch (def.control.kind) {
    case 'choice':
      return <ChoiceControl control={def.control} value={value} onChange={onChange} id={id} scope={scope} />;
    case 'toggle':
      return <ToggleControl value={value} onChange={onChange} id={id} />;
    case 'text':
    case 'number':
      return <TextControl control={def.control} value={value} onChange={onChange} id={id} />;
    case 'list':
      return <LinesControl value={value} onChange={onChange} id={id} placeholder={def.control.placeholder} />;
    case 'map':
      return <LinesControl value={value} onChange={onChange} id={id} pairs />;
  }
}

export function ProviderSettingsPanel({
  brand,
  scope,
  page,
  layer,
}: {
  brand: Brand;
  scope: Scope;
  /** Which of the schema's pages to draw. */
  page: string;
  /** The file a change is written to. */
  layer: Layer;
}) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [unread, setUnread] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const scopeKey = JSON.stringify(scope);

  useEffect(() => {
    let live = true;
    setUnread(null);
    readSettings(brand, scope)
      .then((v) => live && setView(v))
      .catch((e: unknown) => live && setUnread(said(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand, scopeKey, attempt]);

  const change = useCallback(
    async (key: string, value: unknown) => {
      setBusy(key);
      setRefused(null);
      try {
        setView(await writeSettings(brand, scope, layer, { [key]: value }));
      } catch (e) {
        setRefused(said(e));
      } finally {
        setBusy(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [brand, scopeKey, layer],
  );

  const drawn = useMemo(() => pagesFor(brand).find((p) => p.id === page), [brand, page]);
  const target = view?.files.find((f) => f.layer === layer);

  if (unread) {
    return <ReadFailed what="The settings could not be read." why={unread} onRetry={() => setAttempt((n) => n + 1)} />;
  }
  if (!view || !drawn) {
    return (
      <p className="flex items-center gap-2 p-3 text-sm text-t-tertiary">
        <Loader2 className="size-4 animate-spin" /> Reading…
      </p>
    );
  }

  return (
    <div data-testid={`provider-settings-${brand}-${page}`}>
      {refused && (
        <Panel tone="danger" role="alert" className="mb-4 text-sm text-danger">
          {refused}
        </Panel>
      )}
      {drawn.groups.map((group) => {
        const rows = group.settings.filter((s) => !s.scopes || s.scopes.includes(scope.kind));
        if (rows.length === 0) return null;
        return (
          <SettingsGroup key={group.id} title={group.title} description={group.description} data-testid={`settings-group-${group.id}`}>
            {rows.map((def) => {
              const own = target ? getPath(target.value, def.key) : undefined;
              const inForce = effective(view, def.key);
              const elsewhere = inForce.layer && inForce.layer !== layer && inForce.value !== undefined;
              const id = `setting-${brand}-${def.key.replace(/\W+/g, '-')}`;
              const wide = def.control.kind === 'list' || def.control.kind === 'map';
              return (
                <SettingRow
                  key={def.key}
                  htmlFor={id}
                  data-testid={`setting-${def.key}`}
                  stack={wide}
                  label={
                    <span className="flex items-center gap-2">
                      {def.label}
                      {busy === def.key && <Loader2 className="size-3 animate-spin text-t-muted" />}
                    </span>
                  }
                  description={
                    <>
                      {def.description}
                      {elsewhere && (
                        <span className="mt-1 block">
                          <Badge variant="secondary" size="sm" >
                            {layerName(inForce.layer!)}: {asText(inForce.value)}
                          </Badge>
                        </span>
                      )}
                    </>
                  }
                >
                  <SettingControl def={def} value={own} onChange={(v) => change(def.key, v)} id={id} scope={scope} />
                </SettingRow>
              );
            })}
          </SettingsGroup>
        );
      })}
    </div>
  );
}
