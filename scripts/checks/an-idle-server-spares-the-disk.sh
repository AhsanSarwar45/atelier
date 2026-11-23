#!/usr/bin/env bash
# A server nobody is using spares the disk.
#
# The server does work nobody asked for: it sweeps agent records for pictures,
# indexes chats for search, measures and tidies its database. This check starts
# a real server on its own data, with old agent records for that work to find,
# opens no window, and watches what each of the server's threads reads
# (/proc/PID/task/TID/io).
#
# Three things must hold, whatever background work exists now or is added later:
#
#   door   Work nobody asked for runs only on threads named `upkeep…`. With no
#          window open, every other thread together reads next to nothing.
#   pace   The upkeep threads together never read faster than the budget, so
#          the rest of the computer is not kept waiting for the disk.
#   again  Work done once is not done again. A first start reads the records
#          it finds; a second start on the same data reads next to nothing,
#          on any thread.
#
# The records are seeded where the server looks for them by itself: helpers'
# records under its own profiles folder.
#
# Usage: scripts/checks/an-idle-server-spares-the-disk.sh door|pace|again
set -euo pipefail

WHAT="${1:?door, pace or again}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN="$ROOT/tests/.idle-server-run"
export PKG_CONFIG="${PKG_CONFIG:-/usr/bin/pkg-config}"

cargo build --quiet --manifest-path "$ROOT/server/Cargo.toml"
BINARY="${CARGO_TARGET_DIR:-$ROOT/server/target}/debug/atelier"

exec python3 -I - "$WHAT" "$RUN" "$BINARY" <<'PYTHON'
import json, os, shutil, signal, socket, subprocess, sys, time, uuid

what, run, binary = sys.argv[1:4]

SEEDED_FILES = 60           # agent records for the upkeep to find
SEEDED_FILE_MB = 5
WATCHED_S = 150             # longer than the latest start of any upkeep job
WINDOW_S = 10
OTHERS_MAY_READ_MB = 40     # every thread that is not upkeep, over the whole watch
UPKEEP_MAY_READ_MB_S = 4    # the upkeep threads together, in any window
AGAIN_FILES = 8             # for `again`: few enough to be read to the end in one run
AGAIN_FILE_MB = 1
AGAIN_FIRST_S = 420         # the longest the first start may take to finish its work
AGAIN_QUIET_S = 45          # upkeep has finished once it read next to nothing for this long
AGAIN_QUIET_MB = 1          # a look for new work reads a few kilobytes
AGAIN_WATCHED_S = 100       # the second start, past the moment upkeep begins
AGAIN_MAY_READ_MB = 25      # the whole second start, every thread

MB = 1024 * 1024

def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]

shutil.rmtree(run, ignore_errors=True)
data = os.path.join(run, "data")
project = os.path.join(data, "profiles", "claude", "fixture", "projects", "-idle-server-fixture")
os.makedirs(project)
for name in ("claude", "codex", "xdg"):
    os.makedirs(os.path.join(run, name))

# Records helpers finished hours ago, two to a chat.
files, file_mb = (AGAIN_FILES, AGAIN_FILE_MB) if what == "again" else (SEEDED_FILES, SEEDED_FILE_MB)
old = time.time() - 3 * 3600
line = json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "x" * 4000}]}}) + "\n"
body = (line * (file_mb * MB // len(line))).encode()
for n in range(files):
    helpers = os.path.join(project, str(uuid.UUID(int=n // 2 + 1)), "subagents")
    os.makedirs(helpers, exist_ok=True)
    path = os.path.join(helpers, f"agent-{n:017x}.jsonl")
    with open(path, "wb") as f:
        f.write(body)
    os.utime(path, (old, old))
seeded_mb = files * len(body) / MB

def watch(seconds, until=None):
    """Start the server, watch what each thread reads, stop it.

    Returns the bytes read by thread name and upkeep's bytes second by second.
    `until` is asked every second with upkeep's bytes so far; the watch ends
    early when it says so."""
    port, other = free_port(), free_port()
    env = dict(os.environ)
    env.update({
        "ATELIER_PORT": str(port), "BEADS_WEB_PORT": str(port), "BEADS_WORKBENCH_PORT": str(other),
        "BEADS_WEB_HOST": "127.0.0.1",
        "ATELIER_DATA_DIR": data, "XDG_DATA_HOME": os.path.join(run, "xdg"),
        "ATELIER_PRESENTATION_MEDIA_DIR": os.path.join(run, "presentation-media"), "ATELIER_PRESENTATION_EPHEMERAL": "1",
        "CLAUDE_CONFIG_DIR": os.path.join(run, "claude"), "CODEX_HOME": os.path.join(run, "codex"),
        "HISTFILE": os.path.join(run, "bash_history"),
    })
    log = open(os.path.join(run, "server.log"), "ab")
    server = subprocess.Popen([binary], env=env, stdout=log, stderr=log, start_new_session=True)

    def threads():
        """Bytes read so far by each thread still alive, with its name.

        The larger of what the thread asked for in read calls (rchar) and what
        the disk was asked for on its behalf (read_bytes): a file read through
        memory, as SQLite reads its database, makes no read call."""
        seen = {}
        base = f"/proc/{server.pid}/task"
        try:
            tids = os.listdir(base)
        except OSError:
            return seen
        for tid in tids:
            try:
                name = open(f"{base}/{tid}/comm").read().strip()
                io = dict(row.split(": ") for row in open(f"{base}/{tid}/io").read().splitlines())
                seen[tid] = (name, max(int(io["rchar"]), int(io.get("read_bytes", 0))))
            except OSError:
                pass
        return seen

    try:
        last, read, upkeep_by_second = {}, {}, []
        began = time.time()
        while time.time() - began < seconds:
            if server.poll() is not None:
                print(f"WRONG: the server stopped by itself; see {run}/server.log")
                sys.exit(2)
            time.sleep(1)
            now, upkeep = threads(), 0
            for tid, (name, total) in now.items():
                more = total - last.get(tid, (name, 0))[1]
                if more > 0:
                    read[name] = read.get(name, 0) + more
                    if name.startswith("upkeep"):
                        upkeep += more
            last = now
            upkeep_by_second.append(upkeep)
            if until and until(upkeep_by_second):
                break
    finally:
        os.killpg(server.pid, signal.SIGTERM)
        try:
            server.wait(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(server.pid, signal.SIGKILL)
        log.close()
    return read, upkeep_by_second

def split(read):
    upkeep = sum(n for name, n in read.items() if name.startswith("upkeep")) / MB
    others = sum(n for name, n in read.items() if not name.startswith("upkeep")) / MB
    by_thread = ", ".join(f"{name} {n / MB:.0f} MB" for name, n in sorted(read.items(), key=lambda kv: -kv[1])[:6])
    return upkeep, others, by_thread

ok = True
if what in ("door", "pace"):
    read, upkeep_by_second = watch(WATCHED_S)
    upkeep_mb, others_mb, by_thread = split(read)
    fastest = max(sum(upkeep_by_second[i:i + WINDOW_S]) for i in range(len(upkeep_by_second))) / MB / WINDOW_S
    print(f"read in {WATCHED_S} s with no window open: upkeep threads {upkeep_mb:.0f} MB (fastest {fastest:.1f} MB/s), every other thread {others_mb:.0f} MB")
    print(f"by thread: {by_thread}")
    if what == "door":
        if others_mb > OTHERS_MAY_READ_MB:
            print(f"WRONG: threads that are not upkeep read {others_mb:.0f} MB while nobody asked for anything (allowed {OTHERS_MAY_READ_MB} MB)")
            ok = False
        if upkeep_mb < 1:
            print("WRONG: no upkeep thread read anything, so the seeded records were not found and this run proves nothing")
            ok = False
    else:
        if fastest > UPKEEP_MAY_READ_MB_S:
            print(f"WRONG: upkeep read {fastest:.1f} MB/s over {WINDOW_S} s (allowed {UPKEEP_MAY_READ_MB_S} MB/s)")
            ok = False
        if upkeep_mb < 1:
            print("WRONG: no upkeep thread read anything, so there was no pace to measure")
            ok = False
elif what == "again":
    # The first start has done its work once upkeep read what was seeded and
    # then read next to nothing for a while.
    def finished(by_second):
        return (sum(by_second) >= seeded_mb * MB and len(by_second) > AGAIN_QUIET_S
                and sum(by_second[-AGAIN_QUIET_S:]) < AGAIN_QUIET_MB * MB)
    first, first_by_second = watch(AGAIN_FIRST_S, finished)
    first_upkeep, first_others, first_by_thread = split(first)
    print(f"first start, {len(first_by_second)} s: upkeep threads {first_upkeep:.0f} MB, every other thread {first_others:.0f} MB, of {seeded_mb:.0f} MB of records seeded")
    print(f"by thread: {first_by_thread}")
    if not finished(first_by_second):
        print(f"WRONG: the first start had not finished its work after {AGAIN_FIRST_S} s, so there is nothing to compare a second start with")
        ok = False
    second, _ = watch(AGAIN_WATCHED_S)
    second_upkeep, second_others, second_by_thread = split(second)
    second_mb = second_upkeep + second_others
    print(f"second start on the same data, {AGAIN_WATCHED_S} s: upkeep threads {second_upkeep:.0f} MB, every other thread {second_others:.0f} MB")
    print(f"by thread: {second_by_thread}")
    if second_mb > AGAIN_MAY_READ_MB:
        print(f"WRONG: a second start on the same data read {second_mb:.0f} MB again (allowed {AGAIN_MAY_READ_MB} MB)")
        ok = False
else:
    print(f"WRONG: unknown check {what}")
    ok = False

shutil.rmtree(run, ignore_errors=True)
if ok:
    print("ok")
sys.exit(0 if ok else 1)
PYTHON
