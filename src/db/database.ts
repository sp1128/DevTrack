import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations.js';

export type DB = Database.Database;

export interface OpenOptions {
  readonly?: boolean;
  /** 获取写锁时的最长等待时间（毫秒）。多个 Hook 进程可能并发写入。 */
  busyTimeoutMs?: number;
}

export function openDatabase(file: string, options: OpenOptions = {}): DB {
  if (!options.readonly) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { readonly: options.readonly ?? false, fileMustExist: options.readonly ?? false });
  db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
  if (!options.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
  }
  return db;
}

export function getSchemaVersion(db: DB): number {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!exists) return 0;
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  return row.v ?? 0;
}

export function migrate(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const current = getSchemaVersion(db);
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `数据库版本 (${current}) 高于当前 DevTrack 支持的版本 (${LATEST_SCHEMA_VERSION})，请升级 DevTrack。`,
    );
  }
  const pending = MIGRATIONS.filter((m) => m.version > current);
  if (pending.length === 0) return;
  // BEGIN IMMEDIATE：多个进程同时首次建库时，只有一个执行迁移
  const run = db.transaction(() => {
    const again = getSchemaVersion(db);
    for (const m of pending) {
      if (m.version <= again) continue;
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        m.version,
        new Date().toISOString(),
      );
    }
  });
  run.immediate();
}

export const DATA_TABLES = [
  'events',
  'file_changes',
  'commands',
  'tasks',
  'git_commits',
  'token_usage',
  'transcript_offsets',
  'session_git_state',
  'sessions',
  'projects',
] as const;

export function tableCounts(db: DB): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of DATA_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
    counts[table] = row.c;
  }
  return counts;
}
