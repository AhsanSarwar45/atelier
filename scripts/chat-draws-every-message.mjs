/**
 * Nothing the agent kit sends is dropped by the chat.
 *
 * It drives THE DRIVER — `ClaudeDriver`, the thing the app runs — and reads back
 * what it drew. The first version of this check asked the driver's two exported
 * tables whether a kind had a name, which is a question they answer whether or
 * not any code is left that draws one: delete the loop's catch-all arm and that
 * check still passed (bw-1u1.28). This one goes red.
 *
 * Two halves:
 *
 *  - a real chat, one short turn and then `/compact`, so the answer the manager
 *    never got has to arrive — and arrive once, not twice, because the kit sends
 *    it both as a status and as a message it wrote itself (bw-1u1)
 *  - a message of a kind this app has never heard of, handed straight to the
 *    driver, because that is the whole rule: no list of kinds it is willing to
 *    hear (docs/agent-workbench.md §8.2.4)
 *
 *   node scripts/chat-draws-every-message.mjs
 *
 * Needs a signed-in `claude` on the machine and spends one short turn.
 */
import { ClaudeDriver } from '../workbench/src/drivers/claude.ts';

const drawn = [];
const driver = new ClaudeDriver();

/**
 * What a reader sees without asking for anything: the answer, and the grey
 * lines. A `detail` is deliberately not in here — it is the record rather than
 * the reading, and waits behind Ctrl+O (§8.2.4).
 */
function loud(e) {
  if (e.type === 'note') return e.rank === 'note' ? `${e.text} ${e.body ?? ''}` : '';
  if (e.type === 'text.delta') return e.text;
  if (e.type === 'notice' || e.type === 'error') return e.text ?? e.message ?? '';
  return '';
}

await driver.start({
  cwd: process.cwd(),
  permissionMode: 'default',
  emit: (e) => drawn.push(e),
});

/** Waits for the turn in flight to finish, or gives up. */
async function settle(seconds = 180) {
  const mark = drawn.length;
  for (let i = 0; i < seconds * 10; i += 1) {
    const done = drawn
      .slice(mark)
      .some((e) => e.type === 'session.state' && (e.state === 'idle' || e.state === 'errored'));
    if (done) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

await driver.send({ text: 'Say the single word: ready. Nothing else.', images: [] });
const answered = await settle();

const beforeCompact = drawn.length;
await driver.send({ text: '/compact', images: [] });
await settle();
const sinceCompact = drawn.slice(beforeCompact);

// However the kit chose to say it — a status carrying the reason, or a message
// with no stream behind it — it reaches the chat, and it reaches it once.
const compactLines = sinceCompact.map(loud).filter((t) => /compact/i.test(t));

// A kind with no branch anywhere in the driver. Handed to the real loop, not to
// a copy of its tables: this is the line the fault removes.
const beforeUnknown = drawn.length;
driver.draw({ type: 'a_kind_this_app_has_never_heard_of', text: 'something the kit invented today' });
const unknownDrew = drawn.length - beforeUnknown;

// A message the kit wrote ITSELF — no stream behind it, its words only in
// `message.content`. That arm drew nothing at all before this job, and the live
// half above cannot guard it: the same sentence arrives as a status first and
// the second copy is deliberately not drawn twice (bw-1u1.35).
const beforeSynthetic = drawn.length;
driver.draw({
  type: 'assistant',
  message: {
    id: 'a-message-the-kit-wrote-itself',
    model: '<synthetic>',
    content: [{ type: 'text', text: 'A sentence that never came down the stream.' }],
  },
});
const syntheticLines = drawn.slice(beforeSynthetic).map(loud).filter((t) => /never came down the stream/.test(t));

// And the shape the manager's own answer came in, driven the same way, so the
// check does not rest on a live session happening to compact.
const beforeStatus = drawn.length;
driver.draw({ type: 'system', subtype: 'status', compact_result: 'failed', compact_error: 'not enough to compact' });
const statusLines = drawn.slice(beforeStatus).map(loud).filter((t) => /compact/i.test(t));

await driver.close();

const kinds = [...new Set(drawn.filter((e) => e.type === 'note').map((e) => e.kind))].sort();
console.log(`a turn was answered: ${answered ? 'yes' : 'no'}`);
console.log(`kinds of line drawn: ${kinds.join(', ') || 'none'}`);
console.log(`the compact answer, in the live chat: ${compactLines.length} line(s)`);
for (const line of compactLines) console.log(`  ${line.slice(0, 160)}`);
console.log(`an unheard-of kind drew: ${unknownDrew} event(s)`);
console.log(`a message with no stream behind it drew: ${syntheticLines.length} line(s)`);
console.log(`a compact status drew: ${statusLines.length} line(s)`);

const wrong = [];
if (!answered) wrong.push('the session never answered a turn');
if (compactLines.length === 0) wrong.push('the compact answer reached the chat nowhere');
if (compactLines.length > 1) wrong.push(`the compact answer was said ${compactLines.length} times`);
if (unknownDrew === 0) wrong.push('a kind the driver has no branch for was dropped');
if (syntheticLines.length !== 1) wrong.push(`a message with no stream behind it drew ${syntheticLines.length} lines, not 1`);
if (statusLines.length !== 1) wrong.push(`a compact status drew ${statusLines.length} lines, not 1`);

console.log(wrong.length ? `FAIL — ${wrong.join('; ')}` : 'PASS');
process.exit(wrong.length ? 1 : 0);
