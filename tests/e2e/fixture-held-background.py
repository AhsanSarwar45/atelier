#!/usr/bin/env python3
"""Deterministic Claude-shaped ACP peer for a reply that ends while its
background command runs on, and whose end the provider never reports.

It reproduces bw-1fw6 without a model: the prompt request is held open, as the
real adapter holds it while it believes work is live; a real shell holds the
command's output file open until the test creates `finish-bg-N`; the Claude
record ends the reply; and no notice of the command ending is ever sent."""
import json
import os
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

session = str(uuid.uuid4())
cwd = Path(".")
turn = 0


def send(value):
    print(json.dumps({"jsonrpc": "2.0", **value}), flush=True)


def update(value):
    send({"method": "session/update", "params": {"sessionId": session, "update": value}})


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def record(*rows):
    folder = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "projects" / "-held-background"
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / f"{session}.jsonl").open("a") as written:
        for row in rows:
            written.write(json.dumps({"sessionId": session, "timestamp": now(), **row}) + "\n")


def reply(prompt):
    global turn
    turn += 1
    call = f"call-bg-{turn}"
    task = f"bg{turn}"
    tasks = cwd / "tasks"
    tasks.mkdir(exist_ok=True)
    output = (tasks / f"{task}.output").resolve()
    output.touch()
    words = " ".join(part.get("text", "") for part in prompt)
    record({"type": "user", "message": {"role": "user", "content": words}})
    update({"sessionUpdate": "tool_call", "toolCallId": call, "title": f"sleep until finish-bg-{turn}", "kind": "execute", "status": "in_progress", "rawInput": {"command": f"sleep until finish-bg-{turn}", "run_in_background": True}, "_meta": {"claudeCode": {"toolName": "Bash"}}})
    # The command's shell holds its output file open for as long as it runs.
    subprocess.Popen(["sh", "-c", 'exec 3>>"$1"; while [ ! -e "$2" ]; do sleep 0.2; done', "sh", str(output), str((cwd / f"finish-bg-{turn}").resolve())], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    said = f"Command running in background with ID: {task}. Output is being written to: {output}. You will be notified when it completes."
    update({"sessionUpdate": "tool_call_update", "toolCallId": call, "status": "completed", "rawOutput": said, "_meta": {"claudeCode": {"toolName": "Bash", "toolResponse": {"stdout": "", "stderr": "", "backgroundTaskId": task}}}})
    update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "The reply is complete; the command runs on in the background."}})
    record(
        {"type": "assistant", "message": {"role": "assistant", "stop_reason": "tool_use", "content": [{"type": "tool_use", "id": call, "name": "Bash", "input": {}}]}},
        {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": call, "content": said}]}},
        {"type": "assistant", "message": {"role": "assistant", "stop_reason": "end_turn", "content": [{"type": "text", "text": "The reply is complete; the command runs on in the background."}]}},
    )


for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    request_id = request.get("id")
    params = request.get("params", {})
    if method == "initialize":
        result = {"protocolVersion": 1, "agentCapabilities": {"loadSession": True}, "authMethods": [], "agentInfo": {"name": "held-background-fixture", "version": "1"}}
    elif method in ("session/new", "session/load"):
        session = params.get("sessionId", session)
        cwd = Path(params.get("cwd", "."))
        result = {"sessionId": session}
    elif method == "session/prompt":
        reply(params.get("prompt", []))
        # Held, like the real adapter waiting on a notice that never comes.
        continue
    elif method == "_session/steering":
        # The real adapter takes a message sent during a held prompt into the
        # same turn, and the model answers it there.
        send({"id": request_id, "result": {}})
        reply(params.get("prompt", []))
        continue
    elif method == "session/cancel":
        continue
    else:
        result = {}
    if request_id is not None:
        send({"id": request_id, "result": result})
