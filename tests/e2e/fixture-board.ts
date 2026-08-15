import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A throwaway project for a test to drive an agent against: its own git repo,
 * its own beads database, its own reporting tree.
 *
 * Never a live board. The cards here are seeded by import into a database this
 * function creates and the next run destroys.
 */

export const PARENT_CARD = 'wl-demo1';
export const REPORT_PROJECT = 'linkdemo';
export const REPORT_SLUG = 'link-demo';

function bd(args: string[], cwd: string): void {
  execFileSync('bd', args, { cwd, stdio: 'pipe', timeout: 60_000 });
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

/**
 * Builds the fixture and returns its path.
 *
 * `reporting/tools` is a symlink to the real builder so the page is built the
 * way the app builds it, while every page and spec stays inside the fixture.
 */
export function makeFixtureProject(dir: string, reportsDir: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  execFileSync('git', ['init', '-q', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'workbench test'], { cwd: dir, stdio: 'pipe' });

  bd(['init', '--prefix', 'wl'], dir);
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
  writeFileSync(join(pages, `${REPORT_SLUG}.report.json`), JSON.stringify(spec(PARENT_CARD), null, 2) + '\n');

  return dir;
}
