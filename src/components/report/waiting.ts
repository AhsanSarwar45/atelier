/**
 * Which of a project's reports are waiting on an answer (bw-7ks.21.6).
 *
 * A report that ends in a question sits there until it is answered, and until
 * now nothing outside the report itself said so: a page handed over on Monday
 * was unread on Friday because nobody remembered to look. The server counts
 * the questions still holding work up (`server/src/routes/reports.rs`), and
 * these are the words the screens put around that count.
 *
 * What counts as "this project's own" is decided here once, the way the server
 * files a report under a project: the last segment of the folder that holds
 * its board.
 */
import type { ReportEntry } from '@/components/report-panel';
import { projectDir } from '@/lib/utils';

/** The folder name a report is filed under — mirrors the server's basename match. */
export function reportFolder(path: string, localPath?: string | null): string {
  const dir = projectDir({ path, localPath });
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
}

/** This project's own reports, out of every report on the machine. */
export function ownReports(reports: ReportEntry[], folder: string): ReportEntry[] {
  return reports.filter((r) => r.project === folder);
}

/**
 * How many of this project's reports are waiting on the reader.
 *
 * Reports, not questions: one report with three questions in it is one page to
 * open and one sitting to answer them, and a badge saying 3 would send him
 * looking for three pages.
 */
export function waitingCount(reports: ReportEntry[], folder: string): number {
  return ownReports(reports, folder).filter((r) => r.waiting > 0).length;
}

/** The badge's own words. */
export function waitingLabel(count: number): string {
  return count === 1 ? '1 report waiting' : `${count} reports waiting`;
}
