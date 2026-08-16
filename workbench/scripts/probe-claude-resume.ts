/**
 * Does the Claude Agent SDK really resume a conversation begun in a terminal?
 *
 * The restore list rests entirely on that being true, and it is somebody
 * else's contract. When the restore end-to-end test fails, this says in a
 * minute which side is at fault: it starts a session with `claude -p` outside
 * the app, resumes it by id through the SDK alone, and asks it to repeat a
 * word only the first half could know. No sidecar, no server, no browser.
 *
 * How to run it, and where it sits in the index of checks: scripts/README.md.
 * Prints RESUME OK, or the error the SDK raised.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const WORD = 'BANANA';

const dir = mkdtempSync(join(tmpdir(), 'claude-resume-probe-'));
console.log('[probe] cwd', dir);
execFileSync('claude', ['-p', `Remember the word ${WORD}. Reply: OK`, '--permission-mode', 'bypassPermissions'], {
  cwd: dir,
  stdio: 'pipe',
  timeout: 240_000,
});

// The slug is the working directory with every non-alphanumeric character
// replaced by a dash — observed, not documented (docs/agent-workbench.md §9.3).
const slug = dir.replace(/[^A-Za-z0-9]/g, '-');
const files = readdirSync(join(homedir(), '.claude', 'projects', slug)).filter((f) => f.endsWith('.jsonl'));
const id = files[0]!.replace(/\.jsonl$/, '');
console.log('[probe] terminal session id =', id);

async function* prompts() {
  yield {
    type: 'user' as const,
    session_id: '',
    parent_tool_use_id: null,
    message: { role: 'user' as const, content: 'What word did I ask you to remember? Reply with just the word.' },
  };
}

try {
  const q = query({
    prompt: prompts() as never,
    // The same options the driver uses, so a difference here is a real difference.
    options: {
      cwd: dir,
      permissionMode: 'bypassPermissions' as never,
      resume: id,
      forkSession: false,
      includePartialMessages: true,
      strictMcpConfig: true,
      settingSources: [],
    },
  });
  let said = '';
  for await (const m of q as AsyncIterable<Record<string, unknown>>) {
    const msg = m as { type: string; subtype?: string; session_id?: string; message?: { content?: { type: string; text?: string }[] } };
    if (msg.type === 'system' && msg.subtype === 'init') console.log('[probe] resumed session_id =', msg.session_id);
    if (msg.type === 'assistant') for (const b of msg.message?.content ?? []) if (b.type === 'text') said += b.text ?? '';
    if (msg.type === 'result') break;
  }
  console.log('[probe] it said:', JSON.stringify(said.slice(0, 120)));
  console.log(said.includes(WORD) ? '[probe] RESUME OK' : '[probe] RESUMED BUT LOST THE THREAD');
} catch (e) {
  console.log('[probe] RESUME THREW:', e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
