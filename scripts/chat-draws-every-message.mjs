/**
 * Nothing the agent kit sends is dropped by the chat.
 *
 * Runs a real session the way workbench/src/drivers/claude.ts runs one, sends a
 * turn and then `/compact`, and asks of every message that comes back: does the
 * driver translate this kind properly, or does it at least draw it as a line?
 * A kind that is neither is a message the manager would never see, which is the
 * fault this check exists for — his `/compact` answer was one, sent twice and
 * drawn neither time (bw-1u1, docs/agent-workbench.md §8.2.4).
 *
 * Both halves come from the driver itself (`TRANSLATED_KINDS`, `noteFor`), so
 * this check and the code it checks cannot drift apart.
 *
 *   node scripts/chat-draws-every-message.mjs
 *
 * Needs a signed-in `claude` on the machine and spends one short turn.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { kindOf, noteFor, TRANSLATED_KINDS } from '../workbench/src/drivers/claude.ts';

// The agent kit is the sidecar's dependency, not the app's, and this script sits
// above both — so it is resolved from where it actually lives.
const fromSidecar = createRequire(new URL('../workbench/package.json', import.meta.url));
const { query } = await import(pathToFileURL(fromSidecar.resolve('@anthropic-ai/claude-agent-sdk')).href);

const inbox = [];
let wake = null;
let closed = false;

async function* prompts() {
  while (!closed) {
    const next = inbox.shift();
    if (next === undefined) {
      await new Promise((r) => (wake = r));
      continue;
    }
    yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: next } };
  }
}

function send(text) {
  inbox.push(text);
  wake?.();
  wake = null;
}

const q = query({
  prompt: prompts(),
  options: {
    cwd: process.cwd(),
    permissionMode: 'default',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    strictMcpConfig: true,
    settingSources: ['user', 'project', 'local'],
    canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
  },
});

const dropped = new Map();
const drawn = new Map();
let compactAnswer = '';
let turns = 0;

send('Say the single word: ready. Nothing else.');

const giveUp = setTimeout(() => {
  console.log('timed out waiting for the session');
  closed = true;
  q.close();
}, 240_000);

try {
  for await (const m of q) {
    const kind = kindOf(m);
    if (TRANSLATED_KINDS.has(kind)) {
      drawn.set(kind, (drawn.get(kind) ?? 0) + 1);
    } else {
      const note = noteFor(m);
      const bucket = note ? drawn : dropped;
      bucket.set(kind, (bucket.get(kind) ?? 0) + 1);
      if (note && /compact/i.test(note.text)) compactAnswer = note.text;
    }

    // The words of a message the kit wrote itself, which never streams.
    if (m.type === 'assistant' && m.message?.model === '<synthetic>') {
      const said = (m.message?.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(' ');
      if (/compact/i.test(said)) compactAnswer ||= said;
    }

    if (m.type === 'result') {
      turns += 1;
      if (turns === 1) send('/compact');
      else break;
    }
  }
} catch (err) {
  console.log(`the stream ended: ${err instanceof Error ? err.message : String(err)}`);
}
clearTimeout(giveUp);
closed = true;
q.close();

console.log(`kinds drawn: ${[...drawn.keys()].sort().join(', ')}`);
console.log(`dropped kinds: ${dropped.size}${dropped.size ? ` — ${[...dropped.keys()].join(', ')}` : ''}`);
console.log(`compact answered: ${compactAnswer || 'NOTHING'}`);

const failed = dropped.size > 0 || !compactAnswer;
console.log(failed ? 'FAIL' : 'PASS');
process.exit(failed ? 1 : 0);
