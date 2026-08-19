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
 *  - a message the kit wrote itself, a command carrying a whole file, and a
 *    quiet line longer than one line — the three shapes that were drawn wrong
 *    rather than not at all (bw-1u1.35, .33, .40, .39)
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

// A command carrying a whole file in its arguments. What a command PRINTED was
// cut and what it was ASKED to do was cut nowhere, so the first sizeable file
// the agent wrote opened the row onto every byte of it (bw-1u1.33).
const beforeBig = drawn.length;
driver.draw({
  type: 'assistant',
  message: {
    id: 'a-turn-that-writes-a-big-file',
    content: [
      { type: 'tool_use', id: 'big-1', name: 'Write', input: { file_path: '/tmp/big.txt', content: 'x'.repeat(60_000) } },
    ],
  },
});
const asked = drawn.slice(beforeBig).find((e) => e.type === 'tool.started');
const askedSize = asked ? String(asked.input.content ?? '').length : -1;
// The same file arrives a second time as the side-by-side diff, which went into
// the log whole after the arguments beside it had been cut (bw-1u1.40).
const shownDiff = drawn.slice(beforeBig).find((e) => e.type === 'diff');
const diffSize = shownDiff ? String(shownDiff.after ?? '').length : -1;

// A quiet line longer than one line. Its text is cut at two hundred characters,
// and without a body the row's toggle is disabled — so the rest of it was
// reachable nowhere (bw-1u1.39).
const beforeLong = drawn.length;
driver.draw({ type: 'system', subtype: 'notification', text: 'x'.repeat(500) });
const longNote = drawn.slice(beforeLong).find((e) => e.type === 'note');
const longBody = longNote ? String(longNote.body ?? '').length : -1;

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
console.log(`a 60,000-character argument was stored as: ${askedSize} characters`);
console.log(`the same file, as a diff, was stored as: ${diffSize} characters`);
console.log(`a 500-character quiet line kept a body of: ${longBody} characters`);

const wrong = [];
if (!answered) wrong.push('the session never answered a turn');
if (compactLines.length === 0) wrong.push('the compact answer reached the chat nowhere');
if (compactLines.length > 1) wrong.push(`the compact answer was said ${compactLines.length} times`);
if (unknownDrew === 0) wrong.push('a kind the driver has no branch for was dropped');
if (syntheticLines.length !== 1) wrong.push(`a message with no stream behind it drew ${syntheticLines.length} lines, not 1`);
if (statusLines.length !== 1) wrong.push(`a compact status drew ${statusLines.length} lines, not 1`);
if (askedSize < 0 || askedSize > 4200) wrong.push(`a 60,000-character argument was kept as ${askedSize} characters`);
if (diffSize < 0 || diffSize > 4200) wrong.push(`the same file as a diff was kept as ${diffSize} characters`);
if (longBody !== 500) wrong.push(`a 500-character quiet line kept a body of ${longBody} characters, not 500`);

console.log(wrong.length ? `FAIL — ${wrong.join('; ')}` : 'PASS');
process.exit(wrong.length ? 1 : 0);
