import { describe, expect, it } from 'vitest';

import { diffIsEmpty, diffLine, planDiff } from '@/workbench/tasks/plan-diff';

describe('a plan change, item by item', () => {
  const plan = { outcome: 'Menu', criteria: [{ id: 'a', text: 'Opens' }, { id: 'b', text: 'Keys' }, { id: 'c', text: 'Theme' }] };

  it('finds the added, removed and changed items by id, and the changed fields', () => {
    const amend = { outcome: 'Header menu', criteria: [{ id: 'a', text: 'Opens' }, { id: 'c', text: 'Theme, live' }, { id: 'd', text: 'Search' }] };
    const diff = planDiff('feature', plan, amend);
    expect(diff.added).toEqual([{ id: 'd', before: '', after: 'Search', fields: [] }]);
    expect(diff.removed).toEqual([{ id: 'b', before: 'Keys', after: '', fields: [] }]);
    expect(diff.changed).toEqual([{ id: 'c', before: 'Theme', after: 'Theme, live', fields: [] }]);
    expect(diff.fields).toEqual([{ key: 'outcome', before: 'Menu', after: 'Header menu' }]);
    expect(diffLine(diff)).toBe('+1 criterion “Search” · −1 criterion “Keys” · 1 changed “Theme, live” · outcome changed');
  });

  it('leaves out what did not change', () => {
    const diff = planDiff('feature', plan, { ...plan, criteria: [...plan.criteria, { id: 'd', text: 'Search' }, { id: 'e', text: 'Reset' }] });
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.fields).toEqual([]);
    expect(diffLine(diff)).toBe('+2 criteria');
    expect(diffIsEmpty(planDiff('feature', plan, plan))).toBe(true);
  });

  it('names the other fields of a changed item', () => {
    const screens = [{ id: 'm', name: 'Menu', how_to_reach: 'Header', change: 'Bigger' }];
    const diff = planDiff('ui_change', { screens }, { screens: [{ ...screens[0], change: 'Smaller' }] });
    expect(diff.changed).toEqual([{ id: 'm', before: 'Menu', after: 'Menu', fields: ['change'] }]);
  });

  it('works for every type with a plan list, by its own list and names', () => {
    const scenes = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, scene: `Scene ${i}`, camera: 'front', change: 'x' }));
    expect(diffLine(planDiff('render_change', { scenes: scenes(1) }, { scenes: scenes(3) }))).toBe('+2 scenes');
    expect(diffLine(planDiff('chore', { steps: [{ id: 'a', text: 'A' }] }, { steps: [] }))).toBe('−1 step “A”');
  });

  it('compares a type without plan items field by field', () => {
    const diff = planDiff('bug', { symptom: 'Crash', repro_steps: ['Open'] }, { symptom: 'Crash', repro_steps: ['Open', 'Save'] });
    expect(diff.list).toBe('');
    expect(diff.fields).toEqual([{ key: 'repro_steps', before: ['Open'], after: ['Open', 'Save'] }]);
    expect(diffLine(diff)).toBe('repro steps changed');
  });
});

describe('comparing two copies of a plan', () => {
  it('ignores the order of keys', async () => {
    const { same } = await import('@/workbench/tasks/plan-diff');
    expect(same({ a: 1, b: [{ x: 1, y: 2 }] }, { b: [{ y: 2, x: 1 }], a: 1 })).toBe(true);
    expect(same({ a: 1 }, { a: 2 })).toBe(false);
    expect(diffIsEmpty(planDiff('feature', { outcome: 'o', criteria: [{ id: 'a', text: 't' }] }, { criteria: [{ text: 't', id: 'a' }], outcome: 'o' }))).toBe(true);
  });
});
