/**
 * 数据库迁移。每个版本只追加，不修改已发布的迁移。
 * 所有时间字段均为 UTC ISO-8601 字符串（例如 2026-09-24T08:00:00.000Z），可直接按字典序比较。
 */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE projects (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  path             TEXT NOT NULL UNIQUE,
  git_remote       TEXT,
  is_git           INTEGER NOT NULL DEFAULT 0,
  last_git_scan_at TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE sessions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  session_id       TEXT NOT NULL UNIQUE,
  cwd              TEXT,
  work_root        TEXT,
  title            TEXT,
  model            TEXT,
  source           TEXT,
  git_branch       TEXT,
  started_at       TEXT NOT NULL,
  ended_at         TEXT,
  last_activity_at TEXT NOT NULL,
  duration_seconds INTEGER,
  end_reason       TEXT,
  status           TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX idx_sessions_project ON sessions(project_id);
CREATE INDEX idx_sessions_started ON sessions(started_at);
CREATE INDEX idx_sessions_activity ON sessions(last_activity_at);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  tool_name  TEXT,
  timestamp  TEXT NOT NULL,
  metadata   TEXT
);
CREATE INDEX idx_events_timestamp ON events(timestamp);
CREATE INDEX idx_events_session ON events(session_id, timestamp);

CREATE TABLE file_changes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  file_path  TEXT NOT NULL,
  action     TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'claude',
  tool_name  TEXT,
  timestamp  TEXT NOT NULL
);
CREATE INDEX idx_file_changes_timestamp ON file_changes(timestamp);
CREATE INDEX idx_file_changes_session ON file_changes(session_id, file_path);

CREATE TABLE commands (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  command     TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'other',
  exit_code   INTEGER,
  duration_ms INTEGER,
  status      TEXT NOT NULL DEFAULT 'success',
  timestamp   TEXT NOT NULL
);
CREATE INDEX idx_commands_timestamp ON commands(timestamp);

CREATE TABLE git_commits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id    INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  hash          TEXT NOT NULL,
  branch        TEXT,
  message       TEXT,
  author        TEXT,
  timestamp     TEXT NOT NULL,
  files_changed INTEGER NOT NULL DEFAULT 0,
  insertions    INTEGER NOT NULL DEFAULT 0,
  deletions     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(project_id, hash)
);
CREATE INDEX idx_git_commits_timestamp ON git_commits(timestamp);

CREATE TABLE tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  external_id  TEXT NOT NULL,
  source       TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(session_id, source, external_id)
);
CREATE INDEX idx_tasks_completed ON tasks(completed_at);

CREATE TABLE session_git_state (
  session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  snapshot   TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
