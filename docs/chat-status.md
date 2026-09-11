# Chat status ownership

`session.state` is the status authority for app-owned chats. The driver writes
it to the event log; the session row, transcript projection, live sidebar and
restored screen consume that state. Provider notices remain transcript items.
The ACP normalizer translates an active provider condition into a state event,
so the browser does not keep a second state, restore an earlier activity, or
schedule status-restoration timers when a notice expires.

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
