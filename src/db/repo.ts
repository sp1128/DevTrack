import type { DB } from './database.js';

export interface ProjectRow {
  id: number;
  name: string;
  path: string;
  git_remote: string | null;
  is_git: number;
  last_git_scan_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: number;
  project_id: number | null;
  session_id: string;
  cwd: string | null;
  work_root: string | null;
  title: string | null;
  model: string | null;
  source: string | null;
  git_branch: string | null;
  started_at: string;
  ended_at: string | null;
  last_activity_at: string;
  duration_seconds: number | null;
  end_reason: string | null;
  status: 'active' | 'ended' | 'abandoned';
}

export interface ProjectInput {
  name: string;
  path: string;
  gitRemote: string | null;
  isGit: boolean;
}

/** 创建或更新项目。使用 UPSERT，多个 Hook 进程并发首次写入同一项目时也不会冲突。 */
export function upsertProject(db: DB, info: ProjectInput, ts: string): ProjectRow {
  db.prepare(
    `INSERT INTO projects (name, path, git_remote, is_git, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       name = excluded.name,
       git_remote = COALESCE(excluded.git_remote, projects.git_remote),
       is_git = excluded.is_git,
       updated_at = MAX(projects.updated_at, excluded.updated_at)`,
  ).run(info.name, info.path, info.gitRemote, info.isGit ? 1 : 0, ts, ts);
  return db.prepare('SELECT * FROM projects WHERE path = ?').get(info.path) as ProjectRow;
}

export function getProject(db: DB, id: number): ProjectRow | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
}

export function listProjects(db: DB): ProjectRow[] {
  return db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as ProjectRow[];
}

export function touchProject(db: DB, id: number, ts: string): void {
  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ? AND updated_at < ?').run(ts, id, ts);
}

export function setProjectScanTime(db: DB, id: number, ts: string): void {
  db.prepare('UPDATE projects SET last_git_scan_at = ? WHERE id = ?').run(ts, id);
}

export function getSessionByExternalId(db: DB, sessionId: string): SessionRow | undefined {
  return db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as SessionRow | undefined;
}

export interface SessionInput {
  projectId: number;
  sessionId: string;
  cwd: string;
  workRoot: string;
  gitBranch: string | null;
  source: string | null;
  model: string | null;
  title: string | null;
  ts: string;
}

export function createSession(db: DB, input: SessionInput): SessionRow {
  db.prepare(
    `INSERT INTO sessions (project_id, session_id, cwd, work_root, git_branch, source, model, title,
                           started_at, last_activity_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
     ON CONFLICT(session_id) DO NOTHING`,
  ).run(
    input.projectId,
    input.sessionId,
    input.cwd,
    input.workRoot,
    input.gitBranch,
    input.source,
    input.model,
    input.title,
    input.ts,
    input.ts,
  );
  return getSessionByExternalId(db, input.sessionId)!;
}

/** 记录会话的最新活动时间；已结束 / 已放弃的会话收到新活动时重新打开。 */
export function touchSession(db: DB, session: SessionRow, ts: string): void {
  if (session.status !== 'active') {
    db.prepare(
      `UPDATE sessions SET status = 'active', ended_at = NULL, end_reason = NULL, duration_seconds = NULL,
         last_activity_at = MAX(last_activity_at, ?) WHERE id = ?`,
    ).run(ts, session.id);
    session.status = 'active';
    session.ended_at = null;
  } else {
    db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ? AND last_activity_at < ?').run(
      ts,
      session.id,
      ts,
    );
  }
  if (ts > session.last_activity_at) session.last_activity_at = ts;
}

export function updateSessionMeta(
  db: DB,
  id: number,
  fields: { source?: string | null; model?: string | null; title?: string | null; gitBranch?: string | null },
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (fields.source !== undefined && fields.source !== null) {
    sets.push('source = ?');
    values.push(fields.source);
  }
  if (fields.model) {
    sets.push('model = ?');
    values.push(fields.model);
  }
  if (fields.title) {
    sets.push('title = ?');
    values.push(fields.title);
  }
  if (fields.gitBranch) {
    sets.push('git_branch = ?');
    values.push(fields.gitBranch);
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
}

export function endSession(db: DB, session: SessionRow, ts: string, reason: string | null): void {
  const duration = Math.max(0, Math.round((Date.parse(ts) - Date.parse(session.started_at)) / 1000));
  db.prepare(
    `UPDATE sessions SET status = 'ended', ended_at = ?, end_reason = ?, duration_seconds = ?,
       last_activity_at = MAX(last_activity_at, ?) WHERE id = ?`,
  ).run(ts, reason, duration, ts, session.id);
}

/**
 * 没有收到 SessionEnd（终端被直接关闭、进程崩溃等）且长时间无活动的会话标记为 abandoned，
 * 结束时间取最后一次活动时间。之后若再次收到该会话的事件会自动重新打开。
 */
export function closeStaleSessions(db: DB, now: Date, staleHours = 6): number {
  const cutoff = new Date(now.getTime() - staleHours * 3600_000).toISOString();
  const result = db
    .prepare(
      `UPDATE sessions SET status = 'abandoned', ended_at = last_activity_at,
         duration_seconds = CAST(ROUND((julianday(last_activity_at) - julianday(started_at)) * 86400) AS INTEGER)
       WHERE status = 'active' AND last_activity_at < ?`,
    )
    .run(cutoff);
  return result.changes;
}

export interface EventInput {
  sessionId: number | null;
  projectId: number | null;
  type: string;
  toolName?: string | null;
  ts: string;
  metadata?: Record<string, unknown> | null;
}

export function insertEvent(db: DB, e: EventInput): void {
  const metadata = e.metadata && Object.keys(e.metadata).length > 0 ? JSON.stringify(e.metadata) : null;
  db.prepare(
    'INSERT INTO events (session_id, project_id, type, tool_name, timestamp, metadata) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(e.sessionId, e.projectId, e.type, e.toolName ?? null, e.ts, metadata);
}

export type FileAction = 'create' | 'modify' | 'delete' | 'rename';
export type FileSource = 'claude' | 'bash' | 'git';

export interface FileChangeInput {
  sessionId: number | null;
  projectId: number | null;
  filePath: string;
  action: FileAction;
  source: FileSource;
  toolName?: string | null;
  ts: string;
}

export function insertFileChange(db: DB, f: FileChangeInput): void {
  db.prepare(
    `INSERT INTO file_changes (session_id, project_id, file_path, action, source, tool_name, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(f.sessionId, f.projectId, f.filePath, f.action, f.source, f.toolName ?? null, f.ts);
}

export function sessionHasFileChange(db: DB, sessionId: number, filePath: string, since?: string): boolean {
  const row = since
    ? db
        .prepare('SELECT 1 FROM file_changes WHERE session_id = ? AND file_path = ? AND timestamp >= ? LIMIT 1')
        .get(sessionId, filePath, since)
    : db.prepare('SELECT 1 FROM file_changes WHERE session_id = ? AND file_path = ? LIMIT 1').get(sessionId, filePath);
  return row !== undefined;
}

export interface CommandInput {
  sessionId: number | null;
  projectId: number | null;
  command: string;
  category: string;
  exitCode: number | null;
  durationMs: number | null;
  status: 'success' | 'failure' | 'interrupted' | 'background';
  ts: string;
}

export function insertCommand(db: DB, c: CommandInput): void {
  db.prepare(
    `INSERT INTO commands (session_id, project_id, command, category, exit_code, duration_ms, status, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(c.sessionId, c.projectId, c.command, c.category, c.exitCode, c.durationMs, c.status, c.ts);
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

export interface TaskInput {
  sessionId: number;
  projectId: number | null;
  externalId: string;
  source: 'task' | 'todo';
  title?: string | null;
  description?: string | null;
  status?: TaskStatus | null;
  ts: string;
}

/** 创建或更新任务。首次变为 completed 时记录完成时间；重新打开时清空完成时间。 */
export function upsertTask(db: DB, t: TaskInput): void {
  const existing = db
    .prepare('SELECT id, status, completed_at FROM tasks WHERE session_id = ? AND source = ? AND external_id = ?')
    .get(t.sessionId, t.source, t.externalId) as { id: number; status: TaskStatus; completed_at: string | null } | undefined;
  if (!existing) {
    if (!t.title) return; // 没有标题的任务（例如只收到 TaskUpdate）无法展示，跳过
    const status = t.status ?? 'pending';
    db.prepare(
      `INSERT INTO tasks (session_id, project_id, external_id, source, title, description, status,
                          created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      t.sessionId,
      t.projectId,
      t.externalId,
      t.source,
      t.title,
      t.description ?? null,
      status,
      t.ts,
      t.ts,
      status === 'completed' ? t.ts : null,
    );
    return;
  }
  const status = t.status ?? existing.status;
  let completedAt = existing.completed_at;
  if (status === 'completed' && !completedAt) completedAt = t.ts;
  if (status === 'pending' || status === 'in_progress') completedAt = null;
  db.prepare(
    `UPDATE tasks SET status = ?, completed_at = ?, updated_at = ?,
       title = COALESCE(?, title), description = COALESCE(?, description)
     WHERE id = ?`,
  ).run(status, completedAt, t.ts, t.title ?? null, t.description ?? null, existing.id);
}

export interface CommitInput {
  projectId: number;
  hash: string;
  branch: string | null;
  message: string;
  author: string;
  timestamp: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** 写入提交（按项目 + hash 去重），并尝试关联提交时正在进行的 Claude 会话。返回是否为新提交。 */
export function insertCommit(db: DB, c: CommitInput): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO git_commits
         (project_id, session_id, hash, branch, message, author, timestamp, files_changed, insertions, deletions)
       VALUES (?, (
         SELECT id FROM sessions
          WHERE project_id = ?
            -- git 时间只精确到秒，允许 2 秒误差
            AND started_at <= strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+2 seconds')
            AND COALESCE(ended_at, last_activity_at) >= strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-10 minutes')
          ORDER BY started_at DESC LIMIT 1
       ), ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      c.projectId,
      c.projectId,
      c.timestamp,
      c.timestamp,
      c.hash,
      c.branch,
      c.message,
      c.author,
      c.timestamp,
      c.filesChanged,
      c.insertions,
      c.deletions,
    );
  return result.changes > 0;
}

export function getGitState(
  db: DB,
  sessionId: number,
): { snapshot: Record<string, string>; updatedAt: string } | undefined {
  const row = db.prepare('SELECT snapshot, updated_at FROM session_git_state WHERE session_id = ?').get(sessionId) as
    | { snapshot: string; updated_at: string }
    | undefined;
  if (!row) return undefined;
  try {
    return { snapshot: JSON.parse(row.snapshot) as Record<string, string>, updatedAt: row.updated_at };
  } catch {
    return undefined;
  }
}

export function setGitState(db: DB, sessionId: number, snapshot: Record<string, string>, ts: string): void {
  db.prepare(
    `INSERT INTO session_git_state (session_id, snapshot, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at`,
  ).run(sessionId, JSON.stringify(snapshot), ts);
}
