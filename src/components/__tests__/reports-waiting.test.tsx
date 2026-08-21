/**
 * Saying a report is waiting on an answer (bw-7ks.21.6).
 *
 * The count itself is the board's own reading, made on the server; what these
 * cases hold to is everything around it — which reports a project owns, what
 * the badge says, and that a report nobody is waiting on is not marked.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ReportsList } from '@/components/report/screen/reports-list';
import { ownReports, reportFolder, waitingCount, waitingLabel } from '@/components/report/waiting';
import type { ReportEntry } from '@/components/reports';

function entry(project: string, slug: string, waiting: number): ReportEntry {
  return { project, slug, title: slug, card: null, waiting };
}

const REPORTS: ReportEntry[] = [
  entry('beads-web', 'asking-one-thing', 1),
  entry('beads-web', 'asking-three-things', 3),
  entry('beads-web', 'nothing-waits', 0),
  entry('racing', 'someone-elses-question', 2),
];

// Read when the list renders, so the reports above are already built by then.
vi.mock('@/components/reports', () => ({
  useReports: () => ({ reports: REPORTS, isLoading: false, reload: () => {} }),
}));

describe('which reports a project is waiting on', () => {
  it('counts its own, and not those of another project', () => {
    expect(waitingCount(REPORTS, 'beads-web')).toBe(2);
    expect(waitingCount(REPORTS, 'racing')).toBe(1);
  });

  it('counts a report once however many questions it asks', () => {
    // Three questions on one page is one page to open, not three.
    expect(waitingCount([entry('beads-web', 'asking-three-things', 3)], 'beads-web')).toBe(1);
  });

  it('leaves out a report nothing is waiting on', () => {
    expect(waitingCount([entry('beads-web', 'nothing-waits', 0)], 'beads-web')).toBe(0);
  });

  it('files a report under the folder that holds the board', () => {
    expect(reportFolder('/home/dev/dev/beads-web')).toBe('beads-web');
    expect(reportFolder('C:\\Users\\ahsan\\dev\\beads-web')).toBe('beads-web');
    // A Dolt project's own path is a database address, never a directory.
    expect(reportFolder('dolt://localhost/racing', '/home/dev/dev/racing')).toBe('racing');
  });

  it('hands back every report the project owns, waiting or not', () => {
    expect(ownReports(REPORTS, 'beads-web').map((r) => r.slug)).toEqual([
      'asking-one-thing',
      'asking-three-things',
      'nothing-waits',
    ]);
  });
});

describe('what the badge says', () => {
  it('says one report without a number in front of a plural', () => {
    expect(waitingLabel(1)).toBe('1 report waiting');
    expect(waitingLabel(4)).toBe('4 reports waiting');
  });
});

describe('the list inside the project', () => {
  it('marks the reports waiting on an answer and leaves the rest alone', () => {
    render(<ReportsList projectPath="/home/dev/dev/beads-web" onOpen={() => {}} />);

    const rows = screen.getAllByTestId('reports-list-item');
    expect(rows).toHaveLength(3);
    expect(screen.getAllByTestId('reports-list-waiting')).toHaveLength(2);

    const quiet = rows.find((r) => r.getAttribute('data-report-slug') === 'nothing-waits');
    expect(quiet?.querySelector('[data-testid="reports-list-waiting"]')).toBeNull();
  });
});
