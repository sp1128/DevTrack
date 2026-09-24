import os from 'node:os';
import path from 'node:path';

export interface DevTrackPaths {
  dataDir: string;
  dbFile: string;
  configFile: string;
  logsDir: string;
  logFile: string;
  reportsDir: string;
  backupsDir: string;
}

/**
 * 数据目录：默认 ~/.devtrack（Windows 为 %USERPROFILE%\.devtrack）。
 * 可通过环境变量 DEVTRACK_HOME 覆盖（测试、便携安装时使用）。
 */
export function getDataDir(): string {
  const override = process.env.DEVTRACK_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), '.devtrack');
}

export function getPaths(dataDir: string = getDataDir()): DevTrackPaths {
  const logsDir = path.join(dataDir, 'logs');
  return {
    dataDir,
    dbFile: path.join(dataDir, 'devtrack.db'),
    configFile: path.join(dataDir, 'config.json'),
    logsDir,
    logFile: path.join(logsDir, 'devtrack.log'),
    reportsDir: path.join(dataDir, 'reports'),
    backupsDir: path.join(dataDir, 'backups'),
  };
}

/** Claude Code 的配置目录，遵循官方的 CLAUDE_CONFIG_DIR 环境变量。 */
export function getClaudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), '.claude');
}

/** 用户级 Claude Code 设置文件：~/.claude/settings.json（对所有项目生效）。 */
export function getClaudeSettingsPath(): string {
  return path.join(getClaudeConfigDir(), 'settings.json');
}

/**
 * 统一路径表示：绝对路径；Windows 下使用正斜杠并大写盘符，
 * 例如 D:\code\project-a -> D:/code/project-a。
 */
export function normalizePath(p: string): string {
  let resolved = path.resolve(p);
  if (process.platform === 'win32') {
    resolved = resolved.replace(/\\/g, '/');
    if (/^[a-z]:/.test(resolved)) resolved = resolved[0]!.toUpperCase() + resolved.slice(1);
  }
  if (resolved.length > 1 && resolved.endsWith('/') && !/^[A-Za-z]:\/$/.test(resolved)) {
    resolved = resolved.slice(0, -1);
  }
  return resolved;
}

/** 把路径中的用户主目录替换为 ~，用于终端展示。 */
export function tildify(p: string): string {
  const home = os.homedir();
  if (home && (p === home || p.startsWith(home + path.sep) || p.startsWith(home + '/'))) {
    return '~' + p.slice(home.length);
  }
  return p;
}
