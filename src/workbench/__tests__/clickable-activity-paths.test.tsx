import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { openPathClicked } from '@/workbench/path-chip';
import { SplitPaths } from '@/workbench/split-paths';
import { ToolRow } from '@/workbench/transcript-rows';
import type { TranscriptItem } from '@/workbench/use-session';

const { openLocalPath } = vi.hoisted(() => ({ openLocalPath: vi.fn() }));
vi.mock('@/workbench/open-local-path', () => ({ openLocalPath }));

const path = '/home/me/project/src/sessions.ts';
const item: Extract<TranscriptItem, { kind: 'tool' }> = {
  kind: 'tool', id: 'edit', name: 'Edit', title: `Changed ${path}`, status: 'ok', seconds: 0,
  summary: null, parentId: null, input: { file_path: path }, output: '',
  diff: { path, before: 'old', after: 'new', line: 73 },
  detailsDeferred: true, ranKind: 'edit', ranGrave: false,
};

function draw() {
  return render(
    <SplitPaths.Provider value={(text) => {
      const at = text.indexOf(path);
      return at < 0 ? [{ kind: 'text' as const, text }] : [
        { kind: 'text' as const, text: text.slice(0, at) },
        { kind: 'path' as const, raw: path, absolute: path, line: null },
        { kind: 'text' as const, text: text.slice(at + path.length) },
      ];
    }}>
      <ToolRow item={item} nested={false} />
    </SplitPaths.Provider>,
  );
}

describe('file links in activity', () => {
  it('chips both the edit row and diff header at the first edited line', () => {
    draw();
    const chips = screen.getAllByTestId('path-chip');
    expect(chips).toHaveLength(2);
    for (const chip of chips) {
      expect(chip).toHaveAttribute('data-path-line', '73');
      expect(chip).toHaveAttribute('data-path-target', 'editor');
    }
  });

  it('opens an edit link in the editor at that line without toggling the row', () => {
    draw();
    const chip = screen.getAllByTestId('path-chip')[0]!;
    const event = { target: chip, altKey: false, stopPropagation: vi.fn(), preventDefault: vi.fn() };
    expect(openPathClicked(event)).toBe(true);
    expect(openLocalPath).toHaveBeenCalledWith(path, 'vscode', 73);
    // An edit row is drawn open, so "the chip did not toggle it" reads as the
    // row still being open rather than still being shut (bw-cso1.1).
    expect(screen.getByTestId('tool-row')).toHaveAttribute('data-open', 'true');
  });
});
