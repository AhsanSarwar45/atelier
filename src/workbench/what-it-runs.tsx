/**
 * What a chat is running, on the line above it: the model, and how much it asks.
 *
 * Both were drawn as one run of grey text in the tool's own spelling — `claude ·
 * claude-opus-5 · permission mode: bypassPermissions` — an inch from a picker
 * that calls the same setting "Skip all checks". The words are settled once, in
 * {@link PERMISSION_MODE}, and both the picker and this read them from there
 * (bw-ja9l.1).
 *
 * The mode carries a colour as well as a word, because it is the one thing on
 * this line that MUST be read: a chat that has quietly stopped asking before it
 * runs things is a trap, and grey text an inch long is how it hid. The model
 * takes a hue off its own name, the way every other chip the data colours does
 * (src/lib/bead-labels.ts).
 *
 * This is the first thing on the line allowed to give way when the line runs
 * short, and the only one that can: both are named again on the writing box
 * below, while every chip beside it is a number or a name that means nothing
 * half-drawn (bw-7ks.22.15).
 */
'use client';

import { Cpu, Gauge, Shield, ShieldAlert, ShieldCheck, ShieldHalf, ShieldOff, Workflow } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { hueFor } from '@/lib/bead-labels';
import { cn } from '@/lib/utils';
import { inWords, PERMISSION_MODE, UNKNOWN_MODE_TONE } from '@/workbench/machine-words';
import { BRAND_DEFAULT_MODEL, type CollaborationModeChoice, type EffortChoice, type ModelChoice } from '@/workbench/protocol';

/** The brand's own word for a chat nobody has pinned a model to. */
const BRAND_DEFAULT_LABEL = 'Default model';

/**
 * The one distance between two chips on the chat's status line.
 *
 * Exported because this group sits inside that line and must not space its own
 * two chips differently: it is a shrinking device, not a grouping the reader is
 * meant to see. Written once so the two cannot drift (bw-ja9l.10).
 */
export const CHIP_GAP = 'gap-3';

/**
 * The families this app can name, spelled the way the terminal spells them.
 *
 * The terminal's own line reads `Opus 5 (1M context)`. Nothing else a reader
 * looks at should call that build anything else, and two places here did: this
 * chip ran the wire id through `inWords` and said `Claude opus 5[1m]`, while
 * the picker an inch below it printed `claude-opus-5[1m]` raw (bw-ja9l.11).
 */
const FAMILY_NAME: Record<string, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  fable: 'Fable',
};

/** What a build tag in brackets means, written out. */
const BUILD_NAME: Record<string, string> = {
  '1m': '1M context',
};

/**
 * The one name for a model, wherever a model is named.
 *
 * `announced` is what the picker's list called it, where there is a list. It is
 * the answer for an id this cannot parse, and for a bare family key — `opus`
 * carries no version of its own and the list's `Opus 5` says more than `Opus`
 * would. It is NOT the answer for an id this CAN parse, which is the whole
 * correction: the list a chat announces names the long-context build
 * `claude-opus-5[1m]`, and that is an id and not a name.
 */
export function modelName(wire: string | null, announced?: string | null): string | null {
  if (!wire) return null;
  const id = wire.toLowerCase();
  if (id === BRAND_DEFAULT_MODEL) return BRAND_DEFAULT_LABEL;

  // Codex model ids are identifiers, not labels. Both the picker and the
  // status chip use this branch, so `gpt-5-3-codex` cannot be raw in one and
  // prettied in the other.
  const gpt = /^gpt-([0-9]+(?:[.-][0-9]+)*)(?:-(.*))?$/.exec(id);
  if (gpt) {
    const version = gpt[1]!.replaceAll('-', '.');
    const variant = gpt[2] ? ` ${inWords(gpt[2])}` : '';
    return `GPT ${version}${variant}`;
  }

  const build = /\[([^\]]+)\]$/.exec(id)?.[1] ?? null;
  const parts = id
    .replace(/\[[^\]]*\]$/, '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-(latest|v\d+)$/, '')
    .split('-');

  const family = FAMILY_NAME[parts[0]];
  if (!family) return announced || inWords(wire);

  // `4-5` is one version and not two, and the date has already come off above:
  // what is left after the family is the number a reader knows the model by.
  const version = parts.slice(1).filter((p) => /^\d+$/.test(p)).join('.');
  if (!version && !build) return announced || family;

  const tag = build ? ` (${BUILD_NAME[build] ?? build.toUpperCase()})` : '';
  return `${family}${version ? ` ${version}` : ''}${tag}`;
}

/**
 * The model's name as the picker beside it says it.
 *
 * The picker's list is the only place display names exist, and a chat begun in
 * a terminal has no picker list of its own — nothing is driving it, so nothing
 * announced one. Both cases go through {@link modelName}, which is what keeps
 * this chip and that picker saying one thing.
 */
export function modelWords(model: string | null, models: ModelChoice[]): string | null {
  if (!model) return null;
  return modelName(model, models.find((m) => m.value === model)?.displayName);
}

/**
 * The one name a model is coloured by, whichever spelling arrived.
 *
 * The same model reaches this line under three different strings. A chat this
 * app drives carries whatever the picker put in the store — `opus`. A chat read
 * off its own record carries the id the kit resolved to — `claude-opus-5`, or
 * `claude-opus-5[1m]` for the long-context build. Hashing any of those raw gave
 * one model a different colour in each case, which is the whole of what
 * colouring by data is for (bw-ja9l.6).
 *
 * So the vendor, the build tag, the date and the version are taken off and what
 * is left is the family: `opus`, `sonnet`, `haiku`. Two builds of one model are
 * one colour and their two names are still on the chip, which is the right way
 * round — the colour is what a reader scans and the words are what a reader
 * reads.
 */
export function modelKey(model: string): string {
  if (/^gpt-[0-9]/i.test(model)) return model.toLowerCase().includes('codex') ? 'codex' : 'gpt';
  const family = model
    .toLowerCase()
    .replace(/^claude-/, '')
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-(latest|v\d+)$/, '')
    .replace(/-\d+(-\d+)*$/, '');
  return family || model.toLowerCase();
}

/**
 * The mark on the mode chip, one shield per how much this chat still asks.
 *
 * The mode is the one thing on this line that MUST be read, and it was the only
 * coloured chip with nothing but words in it. A shield that is whole, half or
 * struck through says the same thing the words do, before they are read
 * (bw-ja9l.12). Anything the kit invents after this release gets a plain shield
 * — the honest answer is that we do not know how far it goes.
 */
const MODE_ICON: Record<string, typeof Shield> = {
  default: ShieldCheck,
  plan: ShieldCheck,
  acceptEdits: ShieldHalf,
  dontAsk: ShieldAlert,
  auto: ShieldAlert,
  bypassPermissions: ShieldOff,
};

/** The mode's name and colour, both off the one table (§8.2.4). */
export function modeWords(
  mode: string | null,
): { label: string; tone: typeof UNKNOWN_MODE_TONE; Mark: typeof Shield } | null {
  if (!mode) return null;
  const known = PERMISSION_MODE[mode];
  const Mark = MODE_ICON[mode] ?? Shield;
  return known
    ? { label: known.label, tone: known.tone, Mark }
    : { label: inWords(mode), tone: UNKNOWN_MODE_TONE, Mark };
}

/**
 * The mode's own shield, for anywhere outside this line that draws one.
 *
 * The picker under the writing box wore a fixed `ShieldCheck` whatever the chat
 * was set to, so a chat that had stopped asking altogether still showed the
 * mark for one that asks (bw-ja9l.12).
 */
export function ModeMark({ mode, className }: { mode: string | null; className?: string }) {
  const Mark = modeWords(mode)?.Mark ?? Shield;
  return <Mark className={className} aria-hidden="true" />;
}

/**
 * The pair.
 *
 * Nothing at all when neither is known: a chat whose record says neither draws
 * an empty line rather than a badge guessing on its behalf, because the guess
 * available — the owner's own settings — is about this machine and not about
 * the terminal that chat is running in (bw-ja9l.2).
 */
export function WhatItRuns({
  model,
  permissionMode,
  models,
  effort,
  efforts = [],
  collaborationMode,
  collaborationModes = [],
  className,
}: {
  model: string | null;
  permissionMode: string | null;
  /** The picker's own list, empty for a chat nothing here is driving. */
  models: ModelChoice[];
  effort?: string | null;
  efforts?: EffortChoice[];
  collaborationMode?: string | null;
  collaborationModes?: CollaborationModeChoice[];
  className?: string;
}) {
  const mode = modeWords(permissionMode);
  const named = modelWords(model, models);
  // A chat this app drives with no model pinned is on the brand's default, and
  // saying so is the same fact the picker's top row carries. A chat it does not
  // drive has nothing to say until its record answers.
  const modelLabel = named ?? (models.length ? BRAND_DEFAULT_LABEL : null);
  const effortLabel = effort
    ? efforts.find((choice) => choice.value === effort)?.displayName ?? inWords(effort)
    : null;
  const collaborationLabel = collaborationMode
    ? collaborationModes.find((choice) => choice.value === collaborationMode)?.displayName ?? inWords(collaborationMode)
    : null;

  return (
    <span
      data-testid="session-meta"
      data-model={model ?? ''}
      data-mode={permissionMode ?? ''}
      data-effort={effort ?? ''}
      data-collaboration-mode={collaborationMode ?? ''}
      // `min-w-0 shrink truncate` is the whole reason this group exists: left at
      // its full width the chips inside shrank under their own words and what
      // the chat was running printed straight across the folder chip beside it,
      // which is `shrink-0` and never gives way (bw-7ks.22.15).
      //
      // The spacing is the LINE's and not this group's, and it has to stay that
      // way. A group is how these two chips shrink together; it is not a thing
      // the reader can see, and holding them half a step closer than the line
      // holds everything else drew the four chips as two pairs — 12px, 6px,
      // 12px across the row (bw-ja9l.10). {@link CHIP_GAP} is the one value,
      // read here and by the line itself.
      className={cn('flex min-w-0 shrink items-center truncate whitespace-nowrap', CHIP_GAP, className)}
    >
      {modelLabel && (
        <Badge
          // Hashed off the model's family and never off the words: the words
          // are the picker's where there is a picker and `inWords` where there
          // is not, so hashing them gave one model two colours across the
          // driven and the followed case (bw-ja9l.6).
          hue={hueFor(model ? modelKey(model) : modelLabel)}
          appearance="light"
          size="sm"
          shape="circle"
          data-testid="chat-model-chip"
          data-model={model ?? ''}
          // The wire id in the tooltip: the chip has room for the name, and the
          // id is what a reader needs when two builds of one model are about.
          title={model ? `Model — ${model}` : 'Model — the brand’s own default'}
          className="min-w-0 shrink gap-1 truncate"
        >
          {/* The same mark the model picker under the writing box wears, so the
              two are read as one setting seen twice (bw-ja9l.12). */}
          <Cpu className="size-3 shrink-0" aria-hidden="true" />
          <span className="relative top-px min-w-0 truncate">{modelLabel}</span>
        </Badge>
      )}
      {mode && (
        <Badge
          variant={mode.tone}
          // Ringed, not merely tinted. Every other chip on this line carries a
          // colour the DATA hashed to, and a hashed chip is forced to `outline`
          // and drawn with a ring (badge.tsx). A tint alone left this one as a
          // run of coloured text between two pills — the odd thing out on the
          // one line whose whole job is that the mode is read.
          appearance="outline"
          size="sm"
          shape="circle"
          data-testid="chat-mode-chip"
          data-mode={permissionMode ?? ''}
          data-tone={mode.tone}
          title={`Permission mode — ${mode.label}`}
          className="min-w-0 shrink gap-1 truncate"
        >
          <mode.Mark className="size-3 shrink-0" aria-hidden="true" />
          <span className="relative top-px min-w-0 truncate">{mode.label}</span>
        </Badge>
      )}
      {effortLabel && (
        <Badge
          variant="secondary"
          appearance="outline"
          size="sm"
          shape="circle"
          data-testid="chat-effort-chip"
          data-effort={effort ?? ''}
          title={`Reasoning effort — ${effortLabel}`}
          className="min-w-0 shrink gap-1 truncate"
        >
          <Gauge className="size-3 shrink-0" aria-hidden="true" />
          <span className="relative top-px min-w-0 truncate">{effortLabel}</span>
        </Badge>
      )}
      {collaborationLabel && (
        <Badge
          variant="secondary"
          appearance="outline"
          size="sm"
          shape="circle"
          data-testid="chat-collaboration-mode-chip"
          data-collaboration-mode={collaborationMode ?? ''}
          title={`Collaboration mode — ${collaborationLabel}`}
          className="min-w-0 shrink gap-1 truncate"
        >
          <Workflow className="size-3 shrink-0" aria-hidden="true" />
          <span className="relative top-px min-w-0 truncate">{collaborationLabel}</span>
        </Badge>
      )}
    </span>
  );
}
