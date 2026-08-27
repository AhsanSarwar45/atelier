# External reviewer practices

Invoke `claude --agent reviewer -p`; never repeat the model or permission policy
at call sites. Build an evidence packet with exact base/head hashes, diff, changed
paths, acceptance criteria, applicable instructions, and builder test evidence.

Use user settings only, strict MCP configuration, no session persistence, a JSON
schema, inherited stderr for visibility, and captured stdout for validation.
Start a dedicated process group. Emit a heartbeat during silence. On timeout,
terminate that exact group, wait briefly, then kill it if necessary. Make one
attempt; a retry requires an identified infrastructure cause.

Persist the packet, raw provider envelope, and normalized verdict. Exit 0 for
PASS, 1 for NEEDS_WORK, 2 for REVIEWER_ERROR, and 124 for TIMEOUT. Never translate
an absent or malformed verdict into success.
