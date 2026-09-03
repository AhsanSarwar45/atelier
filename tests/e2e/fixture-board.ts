import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * A throwaway project for a test to drive an agent against: its own git repo,
 * its own beads database, its own reporting tree.
 *
 * Never a live board. The cards here are seeded by import into a database this
 * function creates and the next run destroys.
 */

export const PARENT_CARD = 'wl-demo1';
/** The open child a question can hold up: the builder refuses one naming work already under way. */
export const OPEN_CARD = 'wl-kid2';
export const REPORT_PROJECT = 'linkdemo';
export const REPORT_SLUG = 'link-demo';

/**
 * One `bd` call against the throwaway board, and what it said if it failed.
 *
 * Piped rather than inherited so a fixture does not scribble over the run's
 * output, which means a failure arrives as a bare `ETIMEDOUT` or `status 1`
 * with everything bd actually said thrown away — twice in one live run the only
 * evidence was the word ETIMEDOUT (bw-t26l.20). The minute it was given was
 * also short: `bd init` writes a Dolt database, installs four sets of hooks and
 * commits, which takes seconds on an idle machine and much longer under a suite
 * driving several real agents at once.
 */
export function bd(args: string[], cwd: string): void {
  try {
    execFileSync('bd', args, { cwd, stdio: 'pipe', timeout: 240_000 });
  } catch (error) {
    const failed = error as { stdout?: Buffer; stderr?: Buffer };
    const said = [failed.stdout?.toString(), failed.stderr?.toString()].filter(Boolean).join('\n').trim();
    throw new Error(`bd ${args.join(' ')} in ${cwd} failed: ${String(error)}${said ? `\n${said}` : ''}`);
  }
}

/** A spec the report builder accepts: it insists on all six slots. */
function spec(card: string): unknown {
  return {
    title: 'Linked From The Chat',
    eyebrow: 'Opened from the conversation that made it.',
    actions: { none: true, fyi: 'Nothing waits on you.' },
    status: { card },
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
        why: 'The agent is never asked to remember which card it worked on.',
      },
    ],
    next: {
      if_nothing: 'The link stays on the board either way.',
      steps: [{ step: 'Read the page', cost: 'small', starting: true }],
    },
  };
}

/** The question a report can put to the manager, and the answer he can pick. */
export const ASK = 'Keep the wider reading column, or go back to the narrow one?';
export const SAY_KEEP = 'Keep the wider column.';
export const SAY_BACK = 'Go back to the narrow column.';

/**
 * A spec that ASKS something, for the runs that answer it from the page.
 *
 * Same six slots; the difference is the first one, which carries a live
 * question holding up a card the board has not started.
 */
export function askingSpec(card: string): unknown {
  return {
    title: 'A Question For You',
    eyebrow: 'Answered from the page, not from the clipboard.',
    actions: {
      questions: [
        {
          ask: ASK,
          options: [
            { label: 'Keep it', say: SAY_KEEP, pick: true },
            { label: 'Go back', say: SAY_BACK },
          ],
          note: 'A morning of work either way.',
          holds: card,
        },
      ],
    },
    status: { card: PARENT_CARD },
    content: [
      {
        label: 'What changed',
        lead: 'The column is wider and the eye keeps its place.',
        blocks: [
          {
            kind: 'table',
            columns: ['', 'Before', 'After'],
            rows: [['Letters on a line', '52', '72']],
          },
        ],
      },
    ],
    decisions: [
      {
        id: 'D1',
        title: 'The column is as wide as a page of a book',
        why: 'The eye loses its place past that.',
      },
    ],
    next: {
      if_nothing: 'The wider column stays.',
      steps: [{ step: 'Read a long report at the new width', cost: 'small', starting: true }],
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
 * Deleting the project returns as soon as the app has let go, but the embedded
 * Dolt server it was holding takes a moment longer to stop, and it writes while
 * it stops: a plain recursive remove walks into `.beads/embeddeddolt/…/noms`,
 * empties it, and fails with ENOTEMPTY because the process put a file back
 * (observed on chat-edit-links, 2026-09-03). Retrying is what node offers for
 * exactly this, and the tree is gone within a second.
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

  bd(['init', '--prefix', 'wl'], dir);
  // The manifest, because without one the app does not believe this project
  // keeps a board: `/api/beads` answers 404 "Beads is disabled for this
  // project" for any registered project whose manifest does not say
  // `use_beads` (server/src/routes/beads.rs), and every reader of the board on
  // the screen swallows that and draws nothing. A fixture that seeds cards and
  // then denies having a board is a fixture that quietly tests the empty case:
  // it is how a chat checklist — which is a view of this epic, read back
  // through that endpoint — could never appear (bw-t26l.20).
  mkdirSync(join(dir, '.atelier'), { recursive: true });
  writeFileSync(
    join(dir, '.atelier', 'project.toml'),
    [
      'schema_version = 1',
      '',
      '[project]',
      `display_name = "${basename(dir)}"`,
      'use_beads = true',
      'summary = ""',
      '',
      '[git]',
      'completed_work_branch = "master"',
      '',
      '[beads]',
      'issue_id_prefix = "wl"',
      '',
    ].join('\n'),
  );
  const seed = [
    { id: PARENT_CARD, title: 'The card this chat works on', status: 'open', issue_type: 'epic', priority: 1 },
    { id: 'wl-kid1', title: 'First piece of the work', status: 'closed', issue_type: 'task', priority: 1 },
    { id: 'wl-kid2', title: 'Second piece of the work', status: 'open', issue_type: 'task', priority: 1 },
  ];
  writeFileSync(join(dir, 'seed.jsonl'), seed.map((s) => JSON.stringify(s)).join('\n') + '\n');
  bd(['import', '--input', 'seed.jsonl'], dir);
  // The report reads its checklist from the card's children.
  bd(['update', 'wl-kid1', '--parent', PARENT_CARD], dir);
  bd(['update', 'wl-kid2', '--parent', PARENT_CARD], dir);

  const pages = join(reportsDir, 'pages', REPORT_PROJECT);
  mkdirSync(pages, { recursive: true });
  try {
    symlinkSync(join(process.env.HOME ?? '', 'dev/beads-web/reporting/tools'), join(reportsDir, 'tools'));
  } catch {
    // Already linked from a previous run.
  }
  const written = opts.specPath ?? join(pages, `${REPORT_SLUG}.report.json`);
  mkdirSync(dirname(written), { recursive: true });
  writeFileSync(written, JSON.stringify(opts.spec ?? spec(PARENT_CARD), null, 2) + '\n');

  return dir;
}
