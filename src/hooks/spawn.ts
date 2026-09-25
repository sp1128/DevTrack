import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { DB } from '../db/database.js';
import { getMeta, setMeta } from '../db/purge.js';
import { logError } from '../logger.js';

/**
 * 在后台启动 `devtrack summarize --session <id> --quiet` 生成会话摘要。
 *
 * AI 调用可能需要几秒到几十秒，不能在 SessionEnd Hook（同步执行、有超时）里等待，
 * 所以启动一个脱离父进程的子进程，Hook 本身立即退出。周报自动生成同理。
 */
export function spawnSessionSummary(sessionId: string): void {
  spawnCli(['summarize', '--session', sessionId, '--quiet'], 'session-summary:spawn');
}

/** 本地时间本周一 0 点（不引入 date-fns，保持 Hook 启动轻量）。 */
export function currentWeekStart(now: Date): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString();
}

const AUTO_REPORT_KEY = 'auto_report_week';

/**
 * 每周第一次会话开始时，在后台生成上周的周报（report.autoWeekly）。
 * 先在数据库中记下本周已触发，同一周内只触发一次。返回是否触发。
 */
export function maybeSpawnWeeklyReport(db: DB, now: Date, spawnFn: (args: string[]) => void = defaultSpawn): boolean {
  const week = currentWeekStart(now);
  if (getMeta(db, AUTO_REPORT_KEY) === week) return false;
  setMeta(db, AUTO_REPORT_KEY, week);
  spawnFn(['report', '--last', '--auto']);
  return true;
}

function defaultSpawn(args: string[]): void {
  spawnCli(args, 'auto-report:spawn');
}

function spawnCli(args: string[], scope: string): void {
  try {
    const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
    const child = spawn(process.execPath, [cli, ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (err) => logError(scope, err));
    child.unref();
  } catch (err) {
    logError(scope, err);
  }
}
