# Chat status ownership

Live runtime facts are the authority for app-owned chats. The saved
`session.state` is a cached projection, never evidence that a turn exists.
`status.rs::resolve` is the single status decision: it takes attachment liveness,
the actual current prompt task, pending answer receivers, activity, and the
last terminal outcome. Stale database activity cannot override these facts.

`WorkbenchRegistry::reconcile_status` applies that decision on open, snapshots,
commands (including sending and stopping), runtime events, and a five-second
sweep. Changes are persisted as ordinary `session.state` events, so the session
row, transcript projection, sidebar, and restored screen share the correction.
An unchanged status creates no new event or clock reset. The sweep also covers
lost notifications; it does not infer completion from a quiet transcript.

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
“Helper working” and retain Stop. Child output cannot replace that phase;
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
helper turn) is repaired back to Helper working, and Stop/reload are verified.
This tests recovery rather than assuming every completion event arrives.

Evidence: `tests/results/bw-b0m4-reconcile-before.png` and
`tests/results/bw-b0m4-reconcile-after.png`. Run against the same isolated adapter
fixture as above; `CHAT_RECONCILE_BASELINE=1` expects the old behavior.
