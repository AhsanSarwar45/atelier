/**
 * Single source of truth for the two bead tags the board reads by.
 *
 * `bd` gives every issue a flat list of labels. Two of them are namespaced and
 * carry meaning for the reader — `area:<system>` and `kind:<bug|feature|chore>`.
 * The rest (`of:`, `step:`, `job`, `size:`, …) are bookkeeping and are not drawn.
 *
 * Chip colors reuse the shared Badge variants, so they follow every theme:
 * `kind` has a fixed variant per known value, `area` is open-ended and gets a
 * stable variant from a hash of its own name.
 */

import type { Bead } from '@/types';

/** Namespaces drawn on the card face and offered in the tag filter. */
export type LabelNamespace = 'area' | 'kind';

/** Drawing order: system first, then kind of work. */
export const LABEL_NAMESPACES: readonly LabelNamespace[] = ['area', 'kind'];

/** Human-readable heading per namespace, used by the filter menu. */
export const LABEL_NAMESPACE_TITLES: Record<LabelNamespace, string> = {
  area: 'System',
  kind: 'Kind',
};

/** One namespaced tag parsed out of a bead's labels. */
export interface BeadTag {
  namespace: LabelNamespace;
  /** The part after the colon, e.g. `board`. */
  value: string;
  /** The label as `bd` stores it, e.g. `area:board`. */
  raw: string;
}

/** Hue per kind of work: a fault reads red, new work blue, upkeep amber. */
const KIND_HUES: Record<string, number> = {
  bug: 2,
  feature: 222,
  chore: 38,
};

/** Hue a system is hashed into, so one system keeps one color. Spaced far
 *  enough apart that neighbours in a column stay told apart. */
const AREA_HUES: readonly number[] = [199, 152, 275, 20, 96, 320, 245, 172, 62, 350, 128, 296];

/** Hue for anything with no seat in the palettes above. */
const UNKNOWN_HUE = 215;

function isNamespace(candidate: string): candidate is LabelNamespace {
  return (LABEL_NAMESPACES as readonly string[]).includes(candidate);
}

/** Parses `area:board` into a tag; returns null for any other label. */
export function parseLabel(label: string): BeadTag | null {
  const colon = label.indexOf(':');
  if (colon <= 0) return null;
  const namespace = label.slice(0, colon);
  const value = label.slice(colon + 1);
  if (!isNamespace(namespace) || value.length === 0) return null;
  return { namespace, value, raw: label };
}

/** The bead's drawable tags, at most one per namespace, in namespace order. */
export function beadTags(bead: Pick<Bead, 'labels'>): BeadTag[] {
  const byNamespace = new Map<LabelNamespace, BeadTag>();
  for (const label of bead.labels ?? []) {
    const tag = parseLabel(label);
    if (tag && !byNamespace.has(tag.namespace)) byNamespace.set(tag.namespace, tag);
  }
  return LABEL_NAMESPACES.map((namespace) => byNamespace.get(namespace)).filter(
    (tag): tag is BeadTag => tag !== undefined,
  );
}

/** The bead's tag in one namespace, or null when it carries none. */
export function tagFor(bead: Pick<Bead, 'labels'>, namespace: LabelNamespace): BeadTag | null {
  return beadTags(bead).find((tag) => tag.namespace === namespace) ?? null;
}

/** Every value seen for a namespace across the given beads, sorted. */
export function tagValues(beads: readonly Pick<Bead, 'labels'>[], namespace: LabelNamespace): string[] {
  const seen = new Set<string>();
  for (const bead of beads) {
    for (const tag of beadTags(bead)) {
      if (tag.namespace === namespace) seen.add(tag.value);
    }
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

function hash(text: string): number {
  let acc = 0;
  for (let i = 0; i < text.length; i += 1) {
    acc = (acc * 31 + text.charCodeAt(i)) >>> 0;
  }
  return acc;
}

/** Chip hue in degrees: fixed for a known kind, hashed for a system. */
export function tagHue(tag: BeadTag): number {
  if (tag.namespace === 'kind') return KIND_HUES[tag.value] ?? UNKNOWN_HUE;
  return AREA_HUES[hash(tag.value) % AREA_HUES.length];
}

/**
 * Whether a bead passes a tag selection.
 *
 * Selections are raw labels (`area:board`). Within one namespace they widen the
 * result (OR); across namespaces they narrow it (AND). No selection passes all.
 */
export function matchesTags(bead: Pick<Bead, 'labels'>, selected: readonly string[]): boolean {
  if (selected.length === 0) return true;
  const own = new Set(beadTags(bead).map((tag) => tag.raw));
  const wanted: Partial<Record<LabelNamespace, string[]>> = {};
  for (const label of selected) {
    const tag = parseLabel(label);
    if (!tag) continue;
    (wanted[tag.namespace] ??= []).push(tag.raw);
  }
  for (const namespace of LABEL_NAMESPACES) {
    const group = wanted[namespace];
    if (group && !group.some((raw: string) => own.has(raw))) return false;
  }
  return true;
}
