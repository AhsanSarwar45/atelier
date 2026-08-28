# Atelier explainer contract

Emit JSON inside an `atelier-widget` fenced block:

```json
{
  "type": "explainer",
  "title": "How session recovery works",
  "summary": "Only missed events are replayed.",
  "nodes": [
    { "id": "drop", "label": "Connection drops", "detail": "The agent keeps working." },
    { "id": "replay", "label": "Replay", "detail": "Resume after sequence 184." },
    { "id": "live", "label": "Live again" }
  ],
  "edges": [
    { "from": "drop", "to": "replay", "label": "reconnect" },
    { "from": "replay", "to": "live", "label": "caught up" }
  ],
  "steps": [
    { "label": "The browser disconnects", "active": ["drop"] },
    { "label": "Missed events replay", "detail": "The saved sequence is the cursor.", "active": ["replay"] },
    { "label": "Streaming resumes", "active": ["live"] }
  ],
  "evidence": [
    { "label": "Session protocol", "path": "/absolute/repo/src/workbench/protocol.ts", "line": 13 }
  ]
}
```

Constraints:

- Text and IDs are non-empty strings of at most 200 characters.
- `nodes` contains 2–12 uniquely identified nodes.
- `edges` contains 1–20 entries; both endpoints name existing nodes.
- `steps` contains 1–12 entries. `active` is non-empty and names existing nodes.
- `evidence` is optional and contains at most 12 entries. Paths are absolute local paths; `line`, when present, is a positive integer.
- Node order is the primary visual path. An edge label is shown between adjacent nodes when that exact edge exists.
