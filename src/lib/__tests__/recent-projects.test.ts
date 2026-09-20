import { describe, expect, it } from 'vitest';

import { recentOthers, RECENT_LIMIT } from '@/lib/recent-projects';

const at = (day: number) => `2026-09-${String(day).padStart(2, '0')}T09:00:00Z`;

const project = (id: string, day: number, archived?: boolean) => ({
  id,
  lastOpened: at(day),
  archivedAt: archived ? at(day) : undefined,
});

describe('the recent projects offered under the bar’s name', () => {
  it('leaves out the project already open, which the bar above is naming', () => {
    const list = recentOthers([project('a', 3), project('b', 2)], 'a');
    expect(list.map((p) => p.id)).toEqual(['b']);
  });

  it('offers the most recently opened first, whatever order it is handed', () => {
    const list = recentOthers([project('old', 1), project('new', 9), project('mid', 5)], null);
    expect(list.map((p) => p.id)).toEqual(['new', 'mid', 'old']);
  });

  it('stops at five, so the sheet never becomes the project list', () => {
    const many = Array.from({ length: 12 }, (_, i) => project(`p${i}`, i + 1));
    const list = recentOthers(many, null);
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list[0].id).toBe('p11');
  });

  it('offers nothing when the only project there is is the open one', () => {
    expect(recentOthers([project('only', 4)], 'only')).toEqual([]);
  });

  it('offers nothing at all when there are no projects', () => {
    expect(recentOthers([], 'a')).toEqual([]);
  });

  it('never offers an archived project, which is one put away on purpose', () => {
    const list = recentOthers([project('live', 2), project('filed', 8, true)], null);
    expect(list.map((p) => p.id)).toEqual(['live']);
  });
});
