import fs from 'node:fs';
import path from 'node:path';
import { getPaths } from './paths.js';

const MAX_LOG_BYTES = 1024 * 1024;

/**
 * 追加一行日志到 ~/.devtrack/logs/devtrack.log。
 * 只记录错误信息本身，从不记录 Hook 的原始输入（可能含源代码或对话）。
 * 本函数永不抛错：日志失败不能影响 Claude Code。
 */
export function writeLog(level: 'error' | 'warn' | 'info', scope: string, message: string): void {
  try {
    const { logFile } = getPaths();
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    try {
      if (fs.statSync(logFile).size > MAX_LOG_BYTES) {
        fs.renameSync(logFile, `${logFile}.1`);
      }
    } catch {
      // 文件不存在
    }
    const line = `${new Date().toISOString()} [${level}] ${scope}: ${message.replace(/\s*\n\s*/g, ' | ')}\n`;
    fs.appendFileSync(logFile, line, 'utf8');
  } catch {
    // 忽略
  }
}

export function logError(scope: string, err: unknown): void {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  writeLog('error', scope, message);
}

/** 统计最近 N 小时内的错误日志条数（doctor 使用）。 */
export function countRecentErrors(hours: number, now: Date = new Date()): { count: number; last?: string } {
  const { logFile } = getPaths();
  let count = 0;
  let last: string | undefined;
  const since = now.getTime() - hours * 3600_000;
  for (const file of [`${logFile}.1`, logFile]) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line.includes('[error]')) continue;
      const ts = Date.parse(line.slice(0, 24));
      if (!Number.isNaN(ts) && ts >= since) {
        count++;
        last = line;
      }
    }
  }
  return { count, last };
}
