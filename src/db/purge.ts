import type { DB } from './database.js';
import { closeStaleSessions } from './repo.js';

/** 删除规则：各表中早于截止时间的记录。仍在进行中的会话不会被删除。 */
export const PURGE_RULES: { table: string; label: string; where: string }[] = [
  { table: 'events', label: '事件', where: 'timestamp < ?' },
  { table: 'file_changes', label: '文件修改', where: 'timestamp < ?' },
  { table: 'commands', label: '命令', where: 'timestamp < ?' },
  { table: 'tasks', label: '任务', where: 'COALESCE(completed_at, updated_at) < ?' },
  { table: 'git_commits', label: 'Git 提交', where: 'timestamp < ?' },
  { table: 'token_usage', label: 'Token 用量', where: 'timestamp < ?' },
  { table: 'transcript_offsets', label: '会话记录读取进度', where: 'updated_at < ?' },
  { table: 'sessions', label: '会话', where: "COALESCE(ended_at, last_activity_at) < ? AND status != 'active'" },
];

export interface PurgeCount {
  table: string;
  label: string;
  count: number;
}

export function countPurge(db: DB, cutoff: Date, now: Date): PurgeCount[] {
  closeStaleSessions(db, now);
  const iso = cutoff.toISOString();
  return PURGE_RULES.map((rule) => ({
    table: rule.table,
    label: rule.label,
    count: (db.prepare(`SELECT COUNT(*) AS c FROM ${rule.table} WHERE ${rule.where}`).get(iso) as { c: number }).c,
  }));
}

/** 删除截止时间之前的数据，返回删除的记录总数。 */
export function purgeBefore(db: DB, cutoff: Date, now: Date): number {
  closeStaleSessions(db, now);
  const iso = cutoff.toISOString();
  let total = 0;
  db.transaction(() => {
    for (const rule of PURGE_RULES) {
      total += db.prepare(`DELETE FROM ${rule.table} WHERE ${rule.where}`).run(iso).changes;
    }
  })();
  return total;
}

export function getMeta(db: DB, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

const AUTO_PURGE_KEY = 'last_auto_purge_at';
const AUTO_PURGE_INTERVAL_MS = 24 * 3600 * 1000;

/**
 * 按 retention.days 自动清理过期数据，每 24 小时最多执行一次。
 * days 为 0 时永久保留。返回删除的记录数（未执行时为 null）。
 */
export function autoPurge(db: DB, retentionDays: number, now: Date): number | null {
  if (retentionDays <= 0) return null;
  const last = Date.parse(getMeta(db, AUTO_PURGE_KEY) ?? '');
  if (!Number.isNaN(last) && now.getTime() - last < AUTO_PURGE_INTERVAL_MS) return null;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 3600 * 1000);
  const deleted = purgeBefore(db, cutoff, now);
  setMeta(db, AUTO_PURGE_KEY, now.toISOString());
  return deleted;
}
