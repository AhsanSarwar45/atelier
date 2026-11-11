import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * A throwaway project for a test to drive an agent against: its own git repo
 * and its own reporting tree, created here and destroyed by the next run.
 */

/**
 * A short id that appears only as words in recorded chats, so anything that
 * names it can be traced to the chat that said it.
 */
export const PARENT_CARD = 'wl-demo1';
export const REPORT_PROJECT = 'linkdemo';
export const REPORT_SLUG = 'link-demo';

/** A spec the report builder accepts: it insists on all six slots. */
function spec(): unknown {
  return {
    title: 'Linked From The Chat',
    eyebrow: 'Opened from the conversation that made it.',
    actions: { none: true, fyi: 'Nothing waits on you.' },
    status: {},
    content: [
      {
        label: 'What happened',
        lead: 'A chat touched a card, and the link was recorded without anyone typing it.',
        blocks: [
          {
            kind: 'table',
            columns: ['', 'Before', 'After'],
            rows: [['Knowing which card a chat worked on', 'nobody knew', 'the app recorded it']],
          },
        ],
      },
    ],
    decisions: [
      {
        id: 'D1',
        title: 'The link is recorded by watching',
        why: 'The agent is never asked to remember what it worked on.',
      },
    ],
    next: {
      if_nothing: 'The link stays either way.',
      steps: [{ step: 'Read the page', cost: 'small', starting: true }],
    },
  };
}

/** What a run may change about the fixture it builds. */
export interface FixtureOptions {
  /** The spec to write, when the default telling-report is not what the run needs. */
  spec?: unknown;
  /** Where to write it, when it must go where a running server reads its specs. */
  specPath?: string;
}

/**
 * Builds the fixture and returns its path.
 *
 * `reporting/tools` is a symlink to the real builder so the page is built the
 * way the app builds it, while every page and spec stays inside the fixture.
 */
/**
 * Throw a fixture tree away, waiting out whoever is still writing in it.
 *
 * Deleting the project returns as soon as the app has let go, but whatever it
 * was running in the tree can take a moment longer to stop and may write while
 * it stops, so a plain recursive remove can fail with ENOTEMPTY. Retrying is
 * what node offers for exactly this, and the tree is gone within a second.
 */
export function discardFixture(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

export function makeFixtureProject(dir: string, reportsDir: string, opts: FixtureOptions = {}): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  execFileSync('git', ['init', '-q', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'workbench test'], { cwd: dir, stdio: 'pipe' });

  mkdirSync(join(dir, '.atelier'), { recursive: true });
  writeFileSync(
    join(dir, '.atelier', 'project.toml'),
    [
      'schema_version = 1',
      '',
      '[project]',
      `display_name = "${basename(dir)}"`,
      'summary = ""',
      '',
    ].join('\n'),
  );
  const pages = join(reportsDir, 'pages', REPORT_PROJECT);
  mkdirSync(pages, { recursive: true });
  try {
    symlinkSync(join(process.env.HOME ?? '', 'dev/beads-web/reporting/tools'), join(reportsDir, 'tools'));
  } catch {
    // Already linked from a previous run.
  }
  const written = opts.specPath ?? join(pages, `${REPORT_SLUG}.report.json`);
  mkdirSync(dirname(written), { recursive: true });
  writeFileSync(written, JSON.stringify(opts.spec ?? spec(), null, 2) + '\n');

  return dir;
}
