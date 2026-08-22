/**
 * The safety net for a run that crashed or was killed mid-test.
 *
 * Every fixture project this suite creates is marked `isTest` and deleted in
 * its own test's `finally` block — but a run that never reaches that `finally`
 * (a killed process, a crashed browser) leaves the row behind. This runs once,
 * after the whole suite, and sweeps up anything still marked.
 *
 * `npx playwright test` with no env set drives the OWNER'S live instance on
 * port 3008 — that is how seven junk cards ended up on his dashboard before
 * this existed — so this must work on that default path, not only under a
 * script that isolates its own settings DB. And because it runs unconditionally
 * after every invocation, including ones where nothing is listening on that
 * port at all, it fails soft: log and exit clean rather than fail a run whose
 * tests otherwise all passed.
 */

// The projects live in the PROGRAM, not in whatever is drawing the screens.
// Driven against a dev preview the two are different addresses, and asking the
// preview for the project list is answered 404 — so this used to shrug and
// leave the leftovers on the real program (bw-81wt.25). Same address as the
// rest of the suite reads its API from, and the browser's address only when
// nothing said otherwise, which is the default single-program case.
const baseURL = process.env.BEADS_E2E_BACKEND || process.env.BEADS_E2E_URL || 'http://localhost:3008';

type ProjectRow = { id: string; isTest?: boolean };

export default async function globalTeardown(): Promise<void> {
  let rows: ProjectRow[];
  try {
    const res = await fetch(`${baseURL}/api/projects?include_test=true`);
    if (!res.ok) {
      console.warn(`[global-teardown] ${baseURL} answered ${res.status}; leaving the project list alone`);
      return;
    }
    rows = (await res.json()) as ProjectRow[];
  } catch (err) {
    console.warn(`[global-teardown] could not reach ${baseURL}: ${(err as Error).message}`);
    return;
  }

  const marked = rows.filter((p) => p.isTest === true);
  for (const project of marked) {
    try {
      await fetch(`${baseURL}/api/projects/${project.id}`, { method: 'DELETE' });
    } catch (err) {
      // One row failing to delete must not stop the rest from being tried.
      console.warn(`[global-teardown] could not delete project ${project.id}: ${(err as Error).message}`);
    }
  }
  if (marked.length > 0) {
    console.log(`[global-teardown] removed ${marked.length} marked project(s) left behind`);
  }
}
