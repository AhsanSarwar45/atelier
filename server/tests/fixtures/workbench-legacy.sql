CREATE TABLE schema_version (version INTEGER NOT NULL);
INSERT INTO schema_version VALUES (9);

CREATE TABLE session (
  id TEXT PRIMARY KEY,
  brand TEXT NOT NULL,
  external_id TEXT,
  project_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  cwd TEXT NOT NULL,
  model TEXT,
  permission_mode TEXT NOT NULL,
  title TEXT,
  state TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  ended_at TEXT,
  imported_at TEXT,
  imported_recipe INTEGER,
  last_spoke_at TEXT,
  followed_to INTEGER,
  followed_drawn INTEGER,
  effort TEXT
);
CREATE TABLE event (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX event_by_session ON event(session_id, seq);
CREATE TABLE bead_link (
  session_id TEXT NOT NULL,
  bead_id TEXT NOT NULL,
  via TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (session_id, bead_id)
);
CREATE TABLE message (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (session_id, message_id)
);
CREATE INDEX message_by_session ON message(session_id, at);
CREATE TABLE turn (
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  brand TEXT NOT NULL,
  day TEXT NOT NULL,
  at TEXT NOT NULL,
  usd REAL,
  input INTEGER,
  output INTEGER,
  total INTEGER,
  PRIMARY KEY (session_id, at)
);
CREATE INDEX turn_by_day ON turn(day, project_id);
CREATE TABLE summary_run (
  project TEXT NOT NULL,
  session_id TEXT NOT NULL,
  at TEXT NOT NULL,
  ms INTEGER NOT NULL,
  PRIMARY KEY (project, session_id, at)
);
CREATE INDEX summary_run_by_project ON summary_run(project, at);
CREATE TABLE transcript_item (
  session_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  visible INTEGER NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (session_id, item_key),
  UNIQUE (session_id, position)
);
CREATE INDEX transcript_item_page ON transcript_item(session_id, visible, position DESC);
CREATE TABLE transcript_projection (
  session_id TEXT PRIMARY KEY,
  projected_seq INTEGER NOT NULL,
  reset_seq INTEGER NOT NULL
);
CREATE TABLE transcript_agent (
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tool_call_id TEXT,
  json TEXT NOT NULL,
  PRIMARY KEY (session_id, agent_id)
);

INSERT INTO session (
  id, brand, external_id, project_id, project_path, cwd, model,
  permission_mode, title, state, origin, created_at, last_active_at,
  ended_at, imported_at, imported_recipe, last_spoke_at, followed_to,
  followed_drawn, effort
) VALUES (
  'old-chat', 'claude', 'native-old-chat', 'project-1', '/project',
  '/project', 'sonnet', 'default', 'Existing chat', 'dormant', 'app',
  '2026-08-20T00:00:00.000Z', '2026-08-20T00:01:00.000Z', NULL,
  '2026-08-20T00:01:00.000Z', 3, '2026-08-20T00:00:30.000Z', 901, 4, 'high'
);
INSERT INTO event VALUES (
  'old-chat', 1, '2026-08-20T00:00:01.000Z', 'text.delta',
  '{"seq":1,"sessionId":"old-chat","at":"2026-08-20T00:00:01.000Z","type":"text.delta","messageId":"answer-1","text":"kept exactly"}'
);
INSERT INTO bead_link VALUES ('old-chat', 'bw-old', 'tool', '2026-08-20T00:00:02.000Z');
INSERT INTO message VALUES ('old-chat', 'answer-1', 'assistant', 'kept exactly', '2026-08-20T00:00:01.000Z');
INSERT INTO turn VALUES ('old-chat', 'project-1', 'claude', '2026-08-20', '2026-08-20T00:01:00.000Z', 0.01, NULL, NULL, NULL);
INSERT INTO summary_run VALUES ('/project', 'old-chat', '2026-08-20T00:01:00.000Z', 120000);
INSERT INTO transcript_item VALUES ('old-chat', 'message:answer-1', 1, 1, 1, '{"kind":"message","id":"answer-1","text":"kept exactly"}');
INSERT INTO transcript_projection VALUES ('old-chat', 1, 0);
INSERT INTO transcript_agent VALUES ('old-chat', 'agent-1', 'tool-1', '{"id":"agent-1","state":"done","result":"kept"}');
