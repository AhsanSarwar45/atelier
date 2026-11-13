#!/bin/sh
# On the owner's real `camera` grid (Corsetta), `grid next` hands out a task.
# Read-only: one GET to the running app.
url="http://127.0.0.1:${ATELIER_PORT:-3008}/api/workbench/grids/a4233238-a3a9-4210-a0d1-c347c11168b6/camera/next"
curl -fsS "$url" | python3 -c '
import json, sys
v = json.load(sys.stdin)
if not v.get("create") or not v.get("left"):
    print("camera FAILED: grid next hands out nothing: left=%s needsCheckInGrid=%s create=%s" % (v.get("left"), v.get("needsCheckInGrid"), v.get("create")))
    sys.exit(1)
print("camera: next hands out %s cells of %s" % (len(v["create"].get("cells", [])), v["scope"]))
'
