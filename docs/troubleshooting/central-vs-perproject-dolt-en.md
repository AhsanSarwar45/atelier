# Central vs per-project Dolt servers

## Symptoms

Atelier shows 0 beads for a project even though `bd list` works in the terminal. Or: `bd sql` returns "Dolt server unreachable at 127.0.0.1:3307".

## What changed

bd v0.59 switched from a single central Dolt server (port 3307) to a separate server per project.

| | Old scheme (pre-v0.59) | New scheme (v0.59+) |
|---|---|---|
| Server | Single on port 3307 | One per project |
| Ports | 3307 | 13307–14306, hashed from project path |
| Databases | All in one place | Each in project's `.beads/dolt/` |
| Startup | Manual | Automatic on first bd command |

## How to find a project's port

```bash
# Option 1: port file (created when server starts)
cat .beads/dolt-server.port

# Option 2: bd info
bd info
# Shows Mode: server, port, and database path

# Option 3: find the process
# Linux/macOS
ss -tlnp | grep dolt
# Windows
netstat -ano | findstr LISTENING | findstr dolt
```

## Common problems

### "Dolt server unreachable at 127.0.0.1:3307"

The per-project server hasn't started yet. Run any bd command from the project directory:

```bash
cd /path/to/project
bd list
# Server starts automatically
```

### Atelier doesn't see project beads

Atelier connects to the central server (3307). Per-project databases on other ports are invisible to it.

Fix: Atelier v0.6+ reads `.beads/dolt-server.port` and connects to the per-project server directly. Update Atelier.

### metadata.json points to 3307 but database is on another port

After updating bd, `metadata.json` may contain `dolt_mode: "server"` without a port. bd defaults to connecting on 3307.

Check:

```bash
cat .beads/metadata.json
# If no dolt_port — bd uses auto-discovery
# .beads/dolt-server.port has the actual port
```

### Data exists on central server but not on per-project

Old projects may have stored their database on the central server. After updating, bd creates a new empty database in `.beads/dolt/`.

Check the central server:

```bash
# Connect to central and list databases
bd sql "SHOW DATABASES"
# If your database is there — migration needed
# See jsonl-to-dolt-migration-en.md
```

## Diagnostics

```bash
# 1. Check project configuration
cat .beads/metadata.json

# 2. Check running Dolt servers
# Linux/macOS
ps aux | grep "dolt sql-server"
# Windows
tasklist | findstr dolt

# 3. Verify bd can see data
bd sql "SELECT COUNT(*) FROM issues"

# 4. Check port
cat .beads/dolt-server.port 2>/dev/null || echo "Port file not found — server not running"
```
