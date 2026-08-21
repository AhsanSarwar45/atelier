# Troubleshooting

Known issues and solutions for Atelier and the bd CLI.

---

**JSONL to Dolt migration** — bd v0.59 switched to Dolt, but old projects store data in `.beads/issues.jsonl`. Automatic migration doesn't exist. This guide covers what doesn't work and a tested import method via Node.js.
[RU](jsonl-to-dolt-migration-ru.md) · [EN](jsonl-to-dolt-migration-en.md)

**Central vs per-project Dolt servers** — bd v0.59 replaced the single central Dolt server (port 3307) with per-project servers on hashed ports. Projects configured for central may stop seeing their data.
[RU](central-vs-perproject-dolt-ru.md) · [EN](central-vs-perproject-dolt-en.md)

**bd list --json broken in v0.59** — the `--json` flag is silently ignored, breaking any automation that parses JSON output. Workaround: use `bd sql` for direct queries.
[RU](bd-list-json-broken-ru.md) · [EN](bd-list-json-broken-en.md)

**Duplicate database names** — two projects can end up with the same `dolt_database` value. Dropping the database destroys data for both. How to detect and prevent this.
[RU](duplicate-database-names-ru.md) · [EN](duplicate-database-names-en.md)
