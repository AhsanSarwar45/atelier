/**
 * Talking to the `bd` CLI.
 *
 * The sidecar shells out itself rather than going through the server's
 * /api/bd/command, whose allow-list does not carry `provenance` — reaching for
 * it would mean editing an upstream file.
 */
import { execFile } from 'node:child_process';

export interface BdResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd: string): Promise<BdResult> {
  return new Promise((resolve) => {
    execFile('bd', args, { cwd, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

/**
 * True only when `bd` knows this id.
 *
 * Measured: `bd show <unknown>` exits 0 and answers
 * `{"error":"no issues found matching the provided IDs"}`, so the exit code
 * proves nothing. The answer must be an array carrying the id back.
 */
export async function issueExists(id: string, cwd: string): Promise<{ exists: boolean; title?: string }> {
  const { stdout } = await run(['show', id, '--json'], cwd);
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) return { exists: false };
    const hit = (parsed as { id?: string; title?: string }[]).find(
      (r) => typeof r.id === 'string' && r.id.toLowerCase() === id.toLowerCase(),
    );
    return hit ? { exists: true, title: hit.title } : { exists: false };
  } catch {
    return { exists: false };
  }
}

/**
 * Binds a session to an issue on the board itself.
 *
 * Idempotent on source:issue:kind:ref, so calling it on every tool call yields
 * exactly one edge per pair — measured, see docs/agent-workbench.md §6.1. The
 * payload is deliberately empty: only the first write of a pair survives, so
 * per-call detail belongs in our own event log.
 */
export async function recordTranscriptLink(
  issue: string,
  sessionId: string,
  cwd: string,
  source: string,
): Promise<boolean> {
  const { ok } = await run(
    ['provenance', 'record', '--issue', issue, '--kind', 'used', '--source', source, '--ref', sessionId, '--ref-kind', 'transcript'],
    cwd,
  );
  return ok;
}

/** Every issue bound to this session — the chat's own list of cards. */
export async function issuesForSession(sessionId: string, cwd: string): Promise<string[]> {
  const { stdout } = await run(['provenance', 'by-ref', sessionId, '--json'], cwd);
  try {
    const rows = JSON.parse(stdout) as { issue_id?: string; ref_kind?: string }[];
    if (!Array.isArray(rows)) return [];
    return [...new Set(rows.filter((r) => r.ref_kind === 'transcript' && r.issue_id).map((r) => r.issue_id!))];
  } catch {
    return [];
  }
}

/** Every session bound to this issue — the card's own list of chats. */
export async function sessionsForIssue(issue: string, cwd: string): Promise<string[]> {
  const { stdout } = await run(['provenance', 'log', issue, '--json'], cwd);
  try {
    const rows = JSON.parse(stdout) as { ref?: string; ref_kind?: string }[];
    if (!Array.isArray(rows)) return [];
    return [...new Set(rows.filter((r) => r.ref_kind === 'transcript' && r.ref).map((r) => r.ref!))];
  } catch {
    return [];
  }
}
