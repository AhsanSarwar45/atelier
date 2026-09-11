#!/usr/bin/env python3
"""Deterministic ACP peer for interruption lifecycle tests; never runs a model."""
import json
import os
import sys
import threading
import time
from pathlib import Path

session = "lifecycle-" + str(os.getpid())
output_lock = threading.Lock()
turn = 0
late_reply = None

def send(value):
    with output_lock:
        print(json.dumps({"jsonrpc": "2.0", **value}), flush=True)

def update(value):
    send({"method": "session/update", "params": {"sessionId": session, "update": value}})

for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    request_id = request.get("id")
    if method == "initialize":
        result = {"protocolVersion": 1, "agentCapabilities": {"loadSession": True}, "authMethods": [], "agentInfo": {"name": "lifecycle-fixture", "version": "1"}}
    elif method in ("session/new", "session/load"):
        session = request.get("params", {}).get("sessionId", session)
        cwd = Path(request.get("params", {}).get("cwd", "."))
        with (cwd / "lifecycle-pids").open("a") as recorded:
            recorded.write(str(os.getpid()) + "\n")
        result = {"sessionId": session}
    elif method == "session/prompt":
        turn += 1
        update({"sessionUpdate": "tool_call", "toolCallId": "call-" + str(turn), "title": "Claim the card", "kind": "execute", "status": "in_progress", "rawInput": {"command": "bd update bw-105s.1 --claim"}, "_meta": {"codex": {"toolName": "Bash"}, "claudeCode": {"toolName": "Bash"}}})
        words = " ".join(part.get("text", "") for part in request.get("params", {}).get("prompt", []))
        if "native-idle" in words:
            late_reply = request_id
            update({"sessionUpdate": "session_info_update", "_meta": {"codex": {"threadStatus": {"type": "idle", "activeFlags": []}}}})
            continue
        if late_reply is not None:
            send({"id": late_reply, "result": {"stopReason": "end_turn"}})
            late_reply = None
        if "crash" in words:
            sys.exit(3)
        if "complete" in words:
            update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "The new turn completed."}})
            send({"id": request_id, "result": {"stopReason": "end_turn"}})
            def late_update():
                time.sleep(0.15)
                update({"sessionUpdate": "session_info_update", "_meta": {"codex": {"threadStatus": {"type": "active", "activeFlags": []}}}})
            threading.Thread(target=late_update, daemon=True).start()
        # Otherwise never answer the prompt, even after session/cancel.
        continue
    elif method == "session/cancel":
        continue
    else:
        result = {}
    if request_id is not None:
        send({"id": request_id, "result": result})
