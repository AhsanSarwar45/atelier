/**
 * Every permission mode the chat's picker offers can actually be taken.
 *
 * The picker lists what the kit says it accepts, and one of those — bypass —
 * came back as a 500 the first time the manager picked it: "Cannot set
 * permission mode to bypassPermissions because the session was not launched
 * with --dangerously-skip-permissions" (2026-08-17). A session is now started
 * with permission to switch while still starting in the mode it is pinned to
 * (bw-1u1, docs/agent-workbench.md §3.1).
 *
 * It drives THE DRIVER, not the kit: a copy of the launch options here would
 * pass with its own flag set while the app's own session was refused, which is
 * exactly the fault this check exists for.
 *
 *   node scripts/chat-takes-every-mode.mjs
 *
 * Needs a signed-in `claude`. Starts a session and sends no turn to it.
 */
import { CLAUDE_PERMISSION_MODES, DEFAULT_PERMISSION_MODE } from '../src/workbench/protocol.ts';
import { ClaudeDriver } from '../workbench/src/drivers/claude.ts';

const driver = new ClaudeDriver();
const said = [];
await driver.start({
  cwd: process.cwd(),
  permissionMode: DEFAULT_PERMISSION_MODE,
  emit: (e) => {
    if (e.type === 'note') said.push(e.text);
  },
});

const refused = [];
for (const mode of CLAUDE_PERMISSION_MODES) {
  try {
    await driver.setMode(mode);
    console.log(`${mode}: taken`);
  } catch (err) {
    refused.push(mode);
    console.log(`${mode}: REFUSED — ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Left where a chat starts, so a session this check touched is never left with
// its cards switched off.
try {
  await driver.setMode(DEFAULT_PERMISSION_MODE);
} catch {
  // Already reported above if it cannot be set at all.
}
await driver.close();

// A mode that changed in silence is the trap this job also fixed: the chat says
// so, in the chat it happened to (§8.2.4).
const quiet = CLAUDE_PERMISSION_MODES.filter((m) => !said.some((line) => line.includes(m)));

console.log(`refused: ${refused.length}${refused.length ? ` — ${refused.join(', ')}` : ''}`);
console.log(`changed in silence: ${quiet.length}${quiet.length ? ` — ${quiet.join(', ')}` : ''}`);
const failed = refused.length > 0 || quiet.length > 0;
console.log(failed ? 'FAIL' : 'PASS');
process.exit(failed ? 1 : 0);
