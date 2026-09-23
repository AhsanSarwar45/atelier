import { describe, expect, it } from 'vitest';
import { buildCustomization, nextEntryName, suggestedItemId } from '../shared-guidance';

describe('lossless shared guidance editing', () => {
  it('generates valid identifiers without colliding with inherited or local items', () => {
    expect(suggestedItemId('Release check!', ['release-check', 'release-check-2'])).toBe('release-check-3');
    expect(suggestedItemId('日本語', [])).toBe('new-item');
    expect(suggestedItemId('Atelier review', [])).toBe('my-atelier-review');
    expect(suggestedItemId('Atelier review', ['my-atelier-review'])).toBe('my-atelier-review-2');
    expect(suggestedItemId('A'.repeat(100), [])).toHaveLength(68);
    expect(suggestedItemId('  Review docs  ', [])).toBe('review-docs');
  });
  it.each<Record<string, string>>([{}, { 'new-2': 'keep' }, { 'new-1': 'a', 'new-3': 'b' }, { 'new-1': '', 'new-2': '' }])('adding never replaces a surviving entry: %j', entries => {
    const original = { ...entries };
    const next = { ...entries, [nextEntryName(entries)]: '' };
    expect(Object.keys(next)).toHaveLength(Object.keys(entries).length + 1);
    expect(next).toMatchObject(original);
  });
  const source = { content: 'global', when: { op: 'always' }, automatic: true, parameters: { runner: 'npm test' } };
  it('does not pin unchanged inherited values', () => {
    expect(buildCustomization(source, source)).toEqual({ disabled: false, content: null, when: null, automatic: null, parameters: {} });
  });
  it('keeps explicit differences while preserving disabled state', () => {
    const draft = { ...source, content: 'project', automatic: false, when: { op: 'project_beads' }, parameters: { runner: 'cargo test', extra: 'value' } };
    expect(buildCustomization(draft, source, true)).toEqual({ disabled: true, content: 'project', when: { op: 'project_beads' }, automatic: false, parameters: draft.parameters });
  });
  it('reset values and removed project-only parameters do not retain stale overrides', () => {
    const overridden = { ...source, parameters: { runner: 'cargo test', extra: 'remove' } };
    expect(buildCustomization(overridden, source).parameters).toEqual({ runner: 'cargo test', extra: 'remove' });
    expect(buildCustomization({ ...overridden, parameters: { runner: 'npm test' } }, source).parameters).toEqual({});
  });
  it('can explicitly override a parameter with an empty string', () => {
    expect(buildCustomization({ ...source, parameters: { runner: '' } }, source).parameters).toEqual({ runner: '' });
  });
});
