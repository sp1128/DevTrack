import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { getSchemaVersion, openDatabase, type DB } from '../src/db/database.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { autoPurge, countPurge, getMeta } from '../src/db/purge.js';
import { makeTempDir, memoryDb, rmrf, rows, send, testConfig } from './helpers.js';

const DAY = 24 * 3600 * 1000;

describe('数据自动清理', () => {
  let dir: string;
  let db: DB;
  const now = new Date('2026-09-25T12:00:00Z');

  beforeEach(() => {
    dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'proj'));
    db = memoryDb();
    // 准备数据时关闭自动清理，否则 SessionStart 会提前触发清理
    const config = testConfig((c) => {
      c.collect.git = false;
      c.retention.days = 0;
    });
    const cwd = path.join(dir, 'proj');
    // 200 天前和 10 天前各一个已结束的会话
    for (const [sid, daysAgo, end] of [
      ['old', 200, true],
      ['recent', 10, true],
    ] as const) {
      const t = now.getTime() - daysAgo * DAY;
      send(db, config, { session_id: sid, hook_event_name: 'SessionStart', cwd }, new Date(t));
      send(db, config, { session_id: sid, hook_event_name: 'PostToolUse', cwd, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: {} }, new Date(t + 60_000));
      if (end) send(db, config, { session_id: sid, hook_event_name: 'SessionEnd', cwd, reason: 'other' }, new Date(t + 120_000));
    }
  });

  afterEach(() => {
    db.close();
    rmrf(dir);
  });

  it('默认保留 180 天', () => {
    expect(defaultConfig().retention.days).toBe(180);
  });

  it('删除超过保留期的数据，保留近期数据', () => {
    expect(countPurge(db, new Date(now.getTime() - 180 * DAY), now).find((c) => c.table === 'sessions')!.count).toBe(1);
    const deleted = autoPurge(db, 180, now);
    expect(deleted).toBeGreaterThan(0);
    expect(rows<{ session_id: string }>(db, 'SELECT session_id FROM sessions').map((r) => r.session_id)).toEqual(['recent']);
    expect(rows(db, 'SELECT * FROM commands')).toHaveLength(1);
    expect(getMeta(db, 'last_auto_purge_at')).toBe(now.toISOString());
  });

  it('24 小时内只执行一次', () => {
    expect(autoPurge(db, 180, now)).not.toBeNull();
    expect(autoPurge(db, 180, new Date(now.getTime() + 3600_000))).toBeNull();
    expect(autoPurge(db, 180, new Date(now.getTime() + DAY + 1000))).not.toBeNull();
  });

  it('days = 0 表示永久保留', () => {
    expect(autoPurge(db, 0, now)).toBeNull();
    expect(rows(db, 'SELECT * FROM sessions')).toHaveLength(2);
  });

  it('SessionStart 时自动清理', () => {
    const config = testConfig((c) => {
      c.collect.git = false;
      c.retention.days = 30;
    });
    send(db, config, { session_id: 'new', hook_event_name: 'SessionStart', cwd: path.join(dir, 'proj') }, now);
    expect(rows<{ session_id: string }>(db, 'SELECT session_id FROM sessions ORDER BY id').map((r) => r.session_id)).toEqual([
      'recent',
      'new',
    ]);
  });
});

describe('数据库迁移', () => {
  let dir: string;
  beforeEach(() => (dir = makeTempDir()));
  afterEach(() => rmrf(dir));

  it('已有的 v1 数据库自动升级，数据不丢失', () => {
    const file = path.join(dir, 'devtrack.db');
    const raw = new Database(file);
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    raw.exec(MIGRATIONS[0]!.sql);
    raw.prepare('INSERT INTO schema_migrations VALUES (1, ?)').run(new Date().toISOString());
    raw.prepare("INSERT INTO projects (name, path, created_at, updated_at) VALUES ('p', '/p', 'x', 'x')").run();
    raw.close();

    const db = openDatabase(file);
    expect(getSchemaVersion(db)).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
    expect(rows(db, 'SELECT * FROM projects')).toHaveLength(1);
    expect(rows(db, "SELECT name FROM sqlite_master WHERE name = 'meta'")).toHaveLength(1);
    db.close();
  });
});
