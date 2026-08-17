"""Opening a chat starts nothing; the first message wakes it.

The rule this encodes is the manager's, 2026-08-17: "clicking just opens it. it
only resumes when we send another message." No browser test can see it — what
must not happen is a process starting — so this drives the sidecar directly and
reports what its own session row says: after `session.open` the chat is still
dormant and has not moved up the list, and after one `prompt.send` it is awake
and has.

It starts a real chat and spends one small turn on it, twice. Point it at a
sidecar with its own data, never the one serving the owner's board:

  XDG_DATA_HOME=<a copy> BEADS_WORKBENCH_PORT=3019 \
    node --experimental-strip-types workbench/src/server.ts &
  XDG_DATA_HOME=<the same copy> python3 scripts/chat-wakes-on-send.py

Exits non-zero, with the state it read, when either half of the rule breaks.
"""
import json
import subprocess
import time
import urllib.request

SIDE = "http://127.0.0.1:3019"


def post(cmd):
    req = urllib.request.Request(
        f"{SIDE}/command",
        data=json.dumps(cmd).encode(),
        headers={"content-type": "application/json"},
    )
    return json.loads(urllib.request.urlopen(req, timeout=120).read())


def get(path):
    return json.loads(urllib.request.urlopen(f"{SIDE}{path}", timeout=60).read())


def row(session_id):
    return next((s for s in get("/sessions") if s["id"] == session_id), None)


def wait_for(session_id, states, timeout=180):
    end = time.time() + timeout
    while time.time() < end:
        s = row(session_id)
        if s and s["state"] in states:
            return s["state"]
        time.sleep(1)
    return row(session_id)["state"] if row(session_id) else "gone"


projects = json.loads(urllib.request.urlopen("http://127.0.0.1:3018/api/projects", timeout=30).read())
p = projects[0]
print("project:", p["name"], p["path"])

started = post({
    "type": "session.start",
    "projectId": p["id"],
    "projectPath": p["path"],
    "brand": "claude",
})
sid = started["id"]
print("started", sid)

post({"type": "prompt.send", "sessionId": sid, "text": "Reply with exactly: OK"})
print("first turn ended in state:", wait_for(sid, {"idle", "errored", "stopped"}))
before = row(sid)
print("external id:", before["externalId"], "last active:", before["lastActiveAt"])

# Nothing survives a restart: the row goes dormant, which is the state a chat is
# in when the owner clicks it days later.
print("restarting the sidecar…")
subprocess.run(["bash", "-c", "kill $(ss -lntpH 'sport = :3019' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)"], check=False)
time.sleep(2)
subprocess.Popen(
    ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning",
     "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "workbench/src/server.ts"],
    env={**__import__("os").environ, "BEADS_WORKBENCH_PORT": "3019"},
    stdout=open("/tmp/sidecar-3019.log", "a"), stderr=subprocess.STDOUT,
)
for _ in range(40):
    try:
        get("/health")
        break
    except Exception:
        time.sleep(0.5)
asleep = row(sid)
print("after the restart:", asleep["state"], "last active:", asleep["lastActiveAt"])

# 1. Opening it starts nothing.
post({
    "type": "session.open",
    "sessionId": sid,
    "brand": "claude",
    "projectId": p["id"],
    "projectPath": p["path"],
})
time.sleep(3)
opened = row(sid)
print("OPEN  -> state:", opened["state"], "| last active:", opened["lastActiveAt"])
assert opened["state"] == "dormant", f"opening woke it: {opened['state']}"
assert opened["lastActiveAt"] == asleep["lastActiveAt"], "opening moved the row up the list"

# 2. The first message wakes it.
post({"type": "prompt.send", "sessionId": sid, "text": "Reply with exactly: AWAKE"})
state = wait_for(sid, {"idle", "errored", "stopped"})
woken = row(sid)
print("SEND  -> state:", state, "| last active:", woken["lastActiveAt"])
assert state == "idle", f"the message did not wake it cleanly: {state}"
assert woken["lastActiveAt"] > asleep["lastActiveAt"], "sending did not move the row up the list"
print("PASS: opening reads, sending wakes.")
