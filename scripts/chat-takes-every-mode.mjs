/**
 * Every permission mode the chat's picker offers can actually be taken.
 *
 * The picker lists what the kit says it accepts, and one of those — bypass —
 * came back as a 500 the first time the manager picked it: "Cannot set
 * permission mode to bypassPermissions because the session was not launched
 * with --dangerously-skip-permissions" (2026-08-17). A session is now started
 * with permission to switch while still starting in the mode it is pinned to,
 * so this walks the whole list and refuses to pass if any of them is refused
 * (bw-1u1, docs/agent-workbench.md §3.1).
 *
 *   node scripts/chat-takes-every-mode.mjs
 *
 * Needs a signed-in `claude`. Starts a session and sends nothing to it.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { CLAUDE_PERMISSION_MODES } from '../src/workbench/protocol.ts';

// The agent kit is the sidecar's dependency, not the app's, and this script sits
// above both — so it is resolved from where it actually lives.
const fromSidecar = createRequire(new URL('../workbench/package.json', import.meta.url));
const { query } = await import(pathToFileURL(fromSidecar.resolve('@anthropic-ai/claude-agent-sdk')).href);

let closed = false;

async function* nothing() {
  // A session with no turn in it: setPermissionMode does not need one, and this
  // check is about the launch, not about a conversation.
  while (!closed) await new Promise((r) => setTimeout(r, 50));
}

const q = query({
  prompt: nothing(),
  options: {
    cwd: process.cwd(),
    permissionMode: 'default',
    // The line under test.
    allowDangerouslySkipPermissions: true,
    strictMcpConfig: true,
    settingSources: ['user', 'project', 'local'],
    canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
  },
});

const refused = [];
for (const mode of CLAUDE_PERMISSION_MODES) {
  try {
    await q.setPermissionMode(mode);
    console.log(`${mode}: taken`);
  } catch (err) {
    refused.push(mode);
    console.log(`${mode}: REFUSED — ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Left where a chat starts, so a session this check touched is never left with
// its cards switched off.
try {
  await q.setPermissionMode('default');
} catch {
  // Already reported above if it cannot be set at all.
}

closed = true;
q.close();

console.log(`refused: ${refused.length}${refused.length ? ` — ${refused.join(', ')}` : ''}`);
console.log(refused.length ? 'FAIL' : 'PASS');
process.exit(refused.length ? 1 : 0);
