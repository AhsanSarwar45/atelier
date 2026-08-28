/**
 * Audits one session by default; pass --apply to atomically switch its visible
 * transcript to the deduplicated projection. Source event rows are never
 * deleted by either mode.
 */
import { Store } from '../src/store.ts';

const sessionId = process.argv[2];
const apply = process.argv.includes('--apply');

if (!sessionId) {
  console.error('usage: tsx workbench/scripts/rebuild-canonical-projection.ts <session-id> [--apply]');
  process.exitCode = 2;
} else {
  const store = new Store();
  try {
    const report = apply
      ? store.rebuildCanonicalProjection(sessionId)
      : store.auditCanonicalProjection(sessionId);
    const { projectedEvents, ...summary } = report;
    console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', projectedEvents: projectedEvents.length, ...summary }, null, 2));
  } finally {
    store.close();
  }
}
