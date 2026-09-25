import { createInterface } from 'node:readline/promises';
import { ConfigError, loadConfig, type DevTrackConfig } from '../config.js';
import { syncAllProjects } from '../core/gitSync.js';
import { openDatabase, type DB } from '../db/database.js';
import { autoPurge } from '../db/purge.js';
import { closeStaleSessions } from '../db/repo.js';
import { setLang } from '../i18n.js';
import { getPaths, type DevTrackPaths } from '../paths.js';

export class CliError extends Error {
  constructor(
    message: string,
    public exitCode = 1,
  ) {
    super(message);
  }
}

export interface CliContext {
  db: DB;
  config: DevTrackConfig;
  paths: DevTrackPaths;
  now: Date;
  close(): void;
}

export function loadConfigOrThrow(file?: string): DevTrackConfig {
  try {
    return loadConfig(file);
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new CliError(`${err.message}\n请修复配置文件，或运行 devtrack config reset 恢复默认配置。`);
    }
    throw err;
  }
}

/** 打开数据库并做查询前的准备：结束长时间无活动的会话、同步各项目的 Git 提交。 */
export function openCli(options: { sync?: boolean } = {}): CliContext {
  const paths = getPaths();
  const config = loadConfigOrThrow(paths.configFile);
  // --lang / DEVTRACK_LANG 已显式指定时不会被覆盖
  setLang(config.lang);
  const db = openDatabase(paths.dbFile);
  const now = new Date();
  closeStaleSessions(db, now);
  autoPurge(db, config.retention.days, now);
  if (options.sync !== false) syncAllProjects(db, config, now);
  return { db, config, paths, now, close: () => db.close() };
}

export async function withCli<T>(options: { sync?: boolean }, fn: (ctx: CliContext) => Promise<T> | T): Promise<T> {
  const ctx = openCli(options);
  try {
    return await fn(ctx);
  } finally {
    ctx.close();
  }
}

/** 危险操作确认。非交互终端必须显式传入 --yes。 */
export async function confirm(question: string, assumeYes: boolean | undefined): Promise<boolean> {
  if (assumeYes) return true;
  if (!process.stdin.isTTY) {
    throw new CliError('当前不是交互式终端，请添加 --yes 参数确认执行。');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} (y/N) `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}
