import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, type DevTrackConfig } from '../src/config.js';
import { openDatabase, type DB } from '../src/db/database.js';
import { handleHookEvent } from '../src/hooks/handler.js';
import { parseHookInput } from '../src/hooks/input.js';

export function makeTempDir(prefix = 'devtrack-test-'): string {
  // realpathSync.native：展开 Windows 的 8.3 短文件名（RUNNER~1）与 macOS 的 /var -> /private/var，
  // 与 git rev-parse 返回的路径保持一致
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 把 DEVTRACK_HOME / CLAUDE_CONFIG_DIR 指向临时目录，返回恢复函数。 */
export function isolateEnv(): { home: string; claude: string; restore: () => void } {
  const root = makeTempDir();
  const home = path.join(root, 'devtrack');
  const claude = path.join(root, 'claude');
  fs.mkdirSync(claude, { recursive: true });
  const prev = { DEVTRACK_HOME: process.env.DEVTRACK_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.DEVTRACK_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claude;
  return {
    home,
    claude,
    restore: () => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmrf(root);
    },
  };
}

export function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: cwd, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** 创建一个带初始提交的 git 仓库。 */
export function createRepo(dir: string, email = 'dev@example.com'): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', email]);
  git(dir, ['config', 'user.name', 'Dev']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'chore: init']);
  return dir;
}

export function commitFile(repo: string, file: string, content: string, message: string, date?: string): void {
  const full = path.join(repo, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  git(repo, ['add', file]);
  const env: Record<string, string> = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {};
  git(repo, ['commit', '-q', '-m', message], env);
}

export function memoryDb(): DB {
  return openDatabase(':memory:');
}

export function testConfig(patch: (c: DevTrackConfig) => void = () => {}): DevTrackConfig {
  const config = defaultConfig();
  patch(config);
  return config;
}

/** 以指定时间处理一条 Hook 事件（输入先经过与生产环境相同的 schema 解析）。 */
export function send(db: DB, config: DevTrackConfig, payload: Record<string, unknown>, at: Date | string = new Date()) {
  const parsed = parseHookInput(payload);
  if (!parsed.success) throw new Error(parsed.error);
  const input = parsed.data;
  return handleHookEvent({ db, config, now: typeof at === 'string' ? new Date(at) : at }, input);
}

export function rows<T = Record<string, unknown>>(db: DB, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
