# bd list --json broken in v0.59

## Symptoms

```bash
bd list --json
# Outputs plain text instead of JSON
# The --json flag is silently ignored
```

Any automation parsing JSON from `bd list` breaks.

## Cause

Bug in bd v0.59.0. The `--json` flag is accepted by the argument parser but has no effect on output format.

## Workarounds

### Option 1: bd sql (recommended)

```bash
# All open issues
bd sql "SELECT id, title, status, priority FROM issues WHERE status = 'open'"

# All issues
bd sql "SELECT * FROM issues WHERE status = 'open'"

# Count by status
bd sql "SELECT status, COUNT(*) FROM issues GROUP BY status"
```

`bd sql` returns tabular format. Not JSON, but stable and parseable.

### Option 2: bd show with a specific ID

```bash
bd show myproject-a1b --json
# --json may work for show (version-dependent)
```

### Option 3: direct SQL via Dolt

If you need real JSON and have mysql CLI installed:

```bash
mysql -h 127.0.0.1 -P $(cat .beads/dolt-server.port) -u root -e \
  "SELECT JSON_OBJECT('id', id, 'title', title, 'status', status) FROM issues WHERE status = 'open'" \
  $(cat .beads/metadata.json | jq -r '.dolt_database')
```

## Status

Known bug. Fix expected in future bd releases.

Atelier works around this by reading data directly from Dolt via SQL, bypassing bd CLI.
