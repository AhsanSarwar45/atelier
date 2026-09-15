# Chat status ownership

A chat's status is decided in one place, `status.rs::reconcile`, from facts that
can be checked at the moment it is asked. The saved `session.state` is only the
cached projection of that decision, never evidence that a turn exists, and no
other code publishes a live turn's standing.

## The facts

- **The runtime's own objects**: attachment liveness, the outstanding prompt
  request (`RequestLease`), open permission and question receivers, the
  activity the normalizer read off provider signals (including a signal's own
  label, such as Retrying), and the last terminal outcome.
- **The provider's record on disk** (`liveness.rs`). For Claude, the JSONL
  record says when the agent's reply ended: its last assistant row carries a
  `stop_reason` other than `tool_use`, with no user row after it. The adapter
  holds the prompt request open for as long as it believes tasks are live, so
  the request alone is the adapter's belief, not proof of work. An ending is
  believed once it is at least two seconds old (the row is written slightly
  before the wire finishes delivering) and not older than the latest message.
- **The machine**. A backgrounded command's shell holds its output file open for
  as long as it runs, and nothing holds it afterwards. The file is named in the
  command's own tool result ("Output is being written to: PATH").

`resolve` is a pure function of those facts. A connected chat waiting on the
person reads Waiting for your answer. A reply still going reads its activity.
A reply that is over, with a task it started still alive, reads
`waiting_for_agents`, drawn as **Background working**. Otherwise it reads its
outcome. A detached chat keeps only a terminal outcome.

## Background tasks

`settle_background` runs inside every reconciliation and closes each open
panel task that is shown to have ended:
- by the notice the provider wrote in its record;
- by a command's output file that no process holds any more;
- by a helper's own record ending its reply, whose last words become the
  answer;
- by the chat's process being gone.

Work that nothing shows has ended stays open. A chat started from a terminal
runs outside the app, so its process not being attached here says nothing
about its tasks. The panel, the chat bar and the sidebar therefore read the
same settled record.

Provider notices of a task's end arrive late or never. In bw-1fw6 a command
finished at 10:08 and its notice was written at 15:03, when its process died.
Two others were never written. The adapter held the turn open throughout, and
the chat read Running · Terminal for hours. Reloading asked the same wrong
question again. The decision no longer waits on those messages.

## Browser proof

`tests/e2e/fixture-held-background.py` is a deterministic Claude-shaped ACP peer
for the bw-1fw6 shape. It holds the prompt open. It starts a real shell that
holds its output file open until the test creates `finish-bg-N` for turn N. It writes a Claude
record ending the reply, and it never sends a notice that the command ended.
Run `chat-background-settles.spec.ts` through `scripts/workbench-e2e.sh` with
`CHAT_HELD_BACKGROUND_FIXTURE=1` and `ATELIER_ACP_CLAUDE_PATH` set to the
fixture. `CHAT_BACKGROUND_BASELINE=1`, with `ATELIER_BINARY` set to a build from
before bw-1fw6, expects the old behaviour: still working, with the shell
Running, fifteen seconds after the command ended. The fixed app reads
Background working while the command runs, then Ready with the shell done,
after a reload too. A message sent while the prompt is still held is steered
into that turn, as the real adapter expects, and settles the same way.

Evidence: `tests/results/bw-1fw6-before.png`, `tests/results/bw-1fw6-after.png`
and `tests/results/bw-1fw6-background-working.png`.

## When it runs

`WorkbenchRegistry::reconcile_status` applies the decision on open, snapshots,
commands (including sending and stopping), every event of an attached chat,
and a five-second sweep. The sweep covers chats whose row or whose last status
event is active, because a row can be put to sleep without an event.

Live signals take the same route. The client removes `session.state` from what
the normalizer produced on the update, prompt-completion and reconciler paths.
The normalizer keeps the signal as a runtime fact, and the client asks the
decision straight away. A permission or question being asked sets it deciding
through its own event. Changes are persisted as ordinary `session.state`
events, so the session row, transcript projection, sidebar and restored screen
share the result. An unchanged status creates no event and no clock reset.
While a reply is going, tasks are looked at no more than every three seconds.

Terminal outcomes written as a runtime closes (Stopped, Failed, Asleep) remain
direct facts; the decision preserves them for a detached chat.

Prompt membership follows the actual future's lifetime through a `RequestLease`,
including a failed spawn, cancellation, or unwinding. Generation IDs prevent an
old request from representing a newer turn. A missing request causes the
runtime reconciliation to settle leftover message/tool activity and orphaned
questions even if its final status callback was missed. Sending chooses prompt
versus steering from these same runtime request facts, never the saved status.

Live reconciliation holds the activity lock through publication, and registry
reconciliation holds attachment identity stable. An older activity reading or
retired driver cannot publish over a newer transition or attachment. Provider
notices remain transcript evidence; an informational notice cannot keep an
activity clock alive once its turn is finished.

Activity belongs to a turn. Finishing a turn clears its running-call list and
settles tools that never returned. A completed turn cannot be revived by a late
provider activity notification. An explicit provider idle notification also ends a turn when its prompt RPC
never resolves. Each prompt has a generation: an old RPC response can report
usage, but cannot finish or fail a newer turn. The next local prompt permits
activity again.
A rendered tool call can name the status only while the chat is running a tool;
stopped, failed and sleeping states have no activity detail or clock.

Stop terminates the current attachment. The driver sends ACP cancellation,
closes its connection and owned process group, then persists the stopped
outcome after the connection's pending tasks are gone. It does not wait for the
outstanding prompt to acknowledge cancellation. The next prompt resumes the
same durable provider conversation through a fresh attachment. The registry
rejects closed senders and only removes the exact attachment it retired.
Stopping an already detached chat is idempotent.

Opening a chat or recovering the app does not overwrite an explicit stopped or
failed outcome merely because there is no provider attached. An unexpected
transport exit uses the same turn cleanup, followed by the failure state.

The deterministic ACP peer in `tests/e2e/fixture-chat-lifecycle.py` deliberately
withholds prompt replies and sends late activity metadata. The browser test in
`chat-stop-settles.spec.ts` covers Stop, provider-process exit, reload, another
turn, repeated Stop, and a provider crash for both adapters. It must run only
against an isolated app with that peer configured for both providers.

The browser regression also holds an old prompt response until the next turn
starts, proving that its delayed completion cannot clear the new activity.

## Parent completion while helpers work

Claude ACP 0.73.0 deliberately holds its prompt response after the parent's SDK
result while a background subagent is live (upstream issues 864/866). The hold
keeps helper output and permission requests inside a valid ACP turn. Therefore
an SDK `end_turn` in the native transcript is not necessarily an ACP prompt
completion. The reported Mobile app critical issues chat reached this hold:
its root answer ended and usage arrived, while a helper kept running.

The bundled adapter now emits `_meta.atelier.turnPhase=waiting_for_agents`
when it defers settlement. The normalizer closes only the parent's message
lanes and publishes the canonical `waiting_for_agents` state. All screens draw
“Background working” and retain Stop. Child output cannot replace that phase;
fresh root output can. The final ACP response uses the usual turn cleanup and
Idle. Permission and question answers update their pending-request facts; the shared
reconciler then derives the current activity. They contain no separate status
restoration rule that could overwrite the helper phase or revive a finished turn.

The phase patch is a release build input and participates in the adapter cache
fingerprint. Updating the app without rebuilding its adapter bundle would omit
the provider-side signal; the changed fingerprint forces that rebuild.

`tests/fixtures/claude-background-query.mjs` uses the actual pinned adapter's
`runAcp`, prompt consumer, and cancellation implementation. It replaces only
provider session creation and the SDK Query generator, following upstream's
session test double. It needs no credentials or live model. Compile revision
`ea7076c0bc324603e65d8c124b7573f158749969`, apply `patchClaudeTurnPhase` from
`scripts/claude-turn-phase.mjs` before compilation, and set
`CLAUDE_ACP_TEST_SOURCE` to that checkout and `ATELIER_ACP_CLAUDE_PATH` to the
fixture executable in an isolated app. Run `claude-background-turn.spec.ts`
with `BEADS_E2E_URL`, `WORKBENCH_E2E_RUN`, and `CLAUDE_ACP_TEST_SOURCE` set.
`CLAUDE_PHASE_BASELINE=1` with the unpatched adapter reproduces Answering after
the parent's final answer. The patched test covers helper work, reload,
permission/question answers, natural Idle, Stop/process exit, and a new turn.

Before/after browser evidence: `tests/results/bw-b0m4-helper-before.png` and
`tests/results/bw-b0m4-helper-after.png`. These use the real adapter with a fake
provider stream; they do not claim to be captures of the owner's running chat.

## Architectural regression

`chat-status-reconciliation.spec.ts` completes a turn through the real pinned
adapter, then deliberately corrupts only the disposable test database to say
Answering, including its stored status event. No event is broadcast and the
provider remains silent. The baseline reopens with Answering and Stop. The
fixed app repairs it to Idle on open, on sending, and through the periodic
sweep without any interaction. The reverse corruption (Idle during a live
helper turn) is repaired back to Background working, and Stop/reload are verified.
This tests recovery rather than assuming every completion event arrives.

Evidence: `tests/results/bw-b0m4-reconcile-before.png` and
`tests/results/bw-b0m4-reconcile-after.png`. Run against the same isolated adapter
fixture as above; `CHAT_RECONCILE_BASELINE=1` expects the old behavior.
