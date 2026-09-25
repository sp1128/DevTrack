import fs from 'node:fs';
import path from 'node:path';
import { ConfigError, loadConfig } from '../../config.js';
import { compareVersions, getClaudeCodeVersion, MIN_VERSION_DURATION, MIN_VERSION_EXEC_FORM } from '../../core/claude.js';
import { formatBytes } from '../../core/format.js';
import { gitVersion } from '../../core/git.js';
import { getSchemaVersion, openDatabase, tableCounts } from '../../db/database.js';
import { LATEST_SCHEMA_VERSION } from '../../db/migrations.js';
import { inspectHooks } from '../../hooks/install.js';
import { countRecentErrors } from '../../logger.js';
import { getClaudeSettingsPath, getPaths, tildify } from '../../paths.js';
import { lastEventTime } from '../../stats/queries.js';
import { c, padEnd } from '../format.js';

type Status = 'ok' | 'warn' | 'fail';

interface Check {
  name: string;
  status: Status;
  message: string;
  fix?: string;
}

const MIN_NODE = '22.12.0';

function checkNode(): Check {
  const version = process.versions.node;
  if (compareVersions(version, MIN_NODE) < 0) {
    return {
      name: 'Node.js',
      status: 'fail',
      message: `当前 v${version}，需要 v${MIN_NODE} 或更高`,
      fix: '升级 Node.js：https://nodejs.org/ （推荐 LTS 版本）',
    };
  }
  return { name: 'Node.js', status: 'ok', message: `v${version}（${tildify(process.execPath)}）` };
}

function checkGit(): Check {
  const version = gitVersion();
  if (!version) {
    return {
      name: 'Git',
      status: 'warn',
      message: '未找到 git 命令，将无法统计提交与工作区文件变化',
      fix: '安装 Git 并确保 git 在 PATH 中：https://git-scm.com/downloads',
    };
  }
  return { name: 'Git', status: 'ok', message: version };
}

function checkClaude(): { check: Check; version: string | null } {
  const { version, raw } = getClaudeCodeVersion();
  if (!raw) {
    return {
      version: null,
      check: {
        name: 'Claude Code',
        status: 'warn',
        message: '未在 PATH 中找到 claude 命令',
        fix: '安装 Claude Code：https://code.claude.com/docs/en/setup ；若已安装，请确认 claude 在 PATH 中',
      },
    };
  }
  if (version && compareVersions(version, MIN_VERSION_DURATION) < 0) {
    return {
      version,
      check: {
        name: 'Claude Code',
        status: 'warn',
        message: `${raw}：低于 ${MIN_VERSION_DURATION}，命令耗时等字段不可用`,
        fix: '升级 Claude Code：claude update',
      },
    };
  }
  return { version, check: { name: 'Claude Code', status: 'ok', message: raw } };
}

function checkHooks(settingsPath: string, claudeVersion: string | null, lastEvent: Date | null): Check[] {
  const info = inspectHooks(settingsPath);
  const checks: Check[] = [];
  if (info.error) {
    return [{ name: 'Claude Code Hooks', status: 'fail', message: info.error, fix: `修复 ${tildify(settingsPath)} 的 JSON 格式后运行 devtrack init` }];
  }
  if (info.installed.length === 0) {
    return [
      {
        name: 'Claude Code Hooks',
        status: 'fail',
        message: `${tildify(settingsPath)} 中没有 DevTrack Hook`,
        fix: '运行 devtrack init 安装 Hook，然后重新启动 Claude Code',
      },
    ];
  }
  if (info.missing.length > 0) {
    checks.push({
      name: 'Claude Code Hooks',
      status: 'fail',
      message: `缺少事件：${info.missing.join(', ')}`,
      fix: '运行 devtrack init 重新安装 Hook',
    });
  } else if (info.problems.length > 0) {
    checks.push({
      name: 'Claude Code Hooks',
      status: 'fail',
      message: info.problems.join('；'),
      fix: 'Node.js 或 DevTrack 的安装位置发生了变化，运行 devtrack init 重新安装 Hook',
    });
  } else if (info.disableAllHooks) {
    checks.push({
      name: 'Claude Code Hooks',
      status: 'fail',
      message: `已安装，但 ${tildify(settingsPath)} 设置了 "disableAllHooks": true`,
      fix: '删除 disableAllHooks 设置或改为 false',
    });
  } else if (info.mode === 'node' && claudeVersion && compareVersions(claudeVersion, MIN_VERSION_EXEC_FORM) < 0) {
    checks.push({
      name: 'Claude Code Hooks',
      status: 'fail',
      message: `已安装（exec 形式），但 Claude Code ${claudeVersion} 低于 ${MIN_VERSION_EXEC_FORM}，不支持该形式`,
      fix: '升级 Claude Code（claude update），或运行 devtrack init --hook-command path',
    });
  } else {
    checks.push({
      name: 'Claude Code Hooks',
      status: 'ok',
      message: `已安装 ${info.installed.length} 个事件（${info.mode === 'path' ? 'PATH 形式' : 'exec 形式'}）：${tildify(settingsPath)}`,
    });
  }
  if (lastEvent) {
    const minutes = Math.round((Date.now() - lastEvent.getTime()) / 60000);
    const ago = minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : minutes < 1440 ? `${Math.round(minutes / 60)} 小时前` : `${Math.round(minutes / 1440)} 天前`;
    checks.push({ name: 'Hook 事件', status: 'ok', message: `最近一次收到事件：${ago}` });
  } else {
    checks.push({
      name: 'Hook 事件',
      status: 'warn',
      message: '尚未收到任何 Hook 事件',
      fix: '安装 Hook 后需要重新启动 Claude Code；启动后在任意项目中与 Claude 对话即可产生记录',
    });
  }
  checks.push({
    name: '任务识别',
    status: 'ok',
    message: info.taskToolsEnabled
      ? '已启用 Claude 任务工具（CLAUDE_CODE_ENABLE_TODO_TOOLS=1）'
      : '新版模型默认不启用任务工具，任务将主要从 Git 提交推断（可运行 devtrack init --enable-task-tools 启用）',
  });
  return checks;
}

function checkSqlite(): Check {
  try {
    const db = openDatabase(':memory:');
    const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
    db.close();
    return { name: 'SQLite', status: 'ok', message: `better-sqlite3 已加载，SQLite ${row.v}` };
  } catch (err) {
    return {
      name: 'SQLite',
      status: 'fail',
      message: `better-sqlite3 加载失败：${(err as Error).message}`,
      fix: '重新安装 DevTrack：npm install -g devtrack（确保使用与运行时相同版本的 Node.js 安装）',
    };
  }
}

function checkDatabase(dbFile: string): { check: Check; lastEvent: Date | null } {
  if (!fs.existsSync(dbFile)) {
    return {
      lastEvent: null,
      check: { name: 'Database', status: 'fail', message: `数据库不存在：${tildify(dbFile)}`, fix: '运行 devtrack init' },
    };
  }
  try {
    const db = openDatabase(dbFile);
    try {
      const integrity = db.pragma('quick_check', { simple: true }) as string;
      if (integrity !== 'ok') {
        return {
          lastEvent: null,
          check: {
            name: 'Database',
            status: 'fail',
            message: `完整性检查失败：${integrity}`,
            fix: '备份后运行 devtrack reset 重建数据库',
          },
        };
      }
      const version = getSchemaVersion(db);
      const counts = tableCounts(db);
      const size = fs.statSync(dbFile).size;
      const lastEvent = lastEventTime(db);
      return {
        lastEvent,
        check: {
          name: 'Database',
          status: version === LATEST_SCHEMA_VERSION ? 'ok' : 'warn',
          message: `${tildify(dbFile)}（${formatBytes(size)}，schema v${version}，${counts.sessions} 个会话，${counts.events} 条事件）`,
        },
      };
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      lastEvent: null,
      check: {
        name: 'Database',
        status: 'fail',
        message: `无法打开数据库：${(err as Error).message}`,
        fix: '检查文件权限；如数据库损坏，可运行 devtrack reset 重建',
      },
    };
  }
}

function checkConfig(configFile: string): Check {
  if (!fs.existsSync(configFile)) {
    return {
      name: 'Configuration',
      status: 'warn',
      message: `配置文件不存在，使用默认配置：${tildify(configFile)}`,
      fix: '运行 devtrack init 生成配置文件',
    };
  }
  try {
    const config = loadConfig(configFile);
    const disabled = Object.entries(config.collect)
      .filter(([k, v]) => !v && k !== 'promptSummary' && k !== 'tokenUsage')
      .map(([k]) => k);
    if (!config.enabled) {
      return {
        name: 'Configuration',
        status: 'warn',
        message: '采集总开关已关闭（enabled: false），不会记录任何数据',
        fix: '运行 devtrack config set enabled true',
      };
    }
    return {
      name: 'Configuration',
      status: 'ok',
      message: `${tildify(configFile)}（数据保留：${config.retention.days > 0 ? `${config.retention.days} 天` : '永久'}${config.collect.tokenUsage ? '；Token 统计：开启' : ''}${disabled.length ? `；已关闭：${disabled.join(', ')}` : ''}）`,
    };
  } catch (err) {
    return {
      name: 'Configuration',
      status: 'fail',
      message: (err as ConfigError).message,
      fix: '修复配置文件，或运行 devtrack config reset 恢复默认配置',
    };
  }
}

function checkPermissions(dirs: string[], settingsPath: string): Check {
  const problems: string[] = [];
  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.devtrack-write-test-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
    } catch (err) {
      problems.push(`${tildify(dir)} 不可写（${(err as NodeJS.ErrnoException).code ?? (err as Error).message}）`);
    }
  }
  const settingsDir = path.dirname(settingsPath);
  try {
    if (fs.existsSync(settingsPath)) fs.accessSync(settingsPath, fs.constants.R_OK | fs.constants.W_OK);
    else if (fs.existsSync(settingsDir)) fs.accessSync(settingsDir, fs.constants.W_OK);
  } catch {
    problems.push(`${tildify(settingsPath)} 不可读写`);
  }
  if (problems.length > 0) {
    return {
      name: 'File permissions',
      status: 'fail',
      message: problems.join('；'),
      fix: '修改目录所有者或权限，例如：chmod -R u+rw ~/.devtrack',
    };
  }
  return { name: 'File permissions', status: 'ok', message: '数据目录与 Claude 设置文件可读写' };
}

function checkErrors(logFile: string): Check {
  const { count, last } = countRecentErrors(24);
  if (count === 0) return { name: 'Hook 错误', status: 'ok', message: '最近 24 小时没有错误' };
  return {
    name: 'Hook 错误',
    status: 'warn',
    message: `最近 24 小时有 ${count} 条错误，最近一条：${(last ?? '').slice(0, 160)}`,
    fix: `查看日志：${tildify(logFile)}（Hook 出错不会影响 Claude Code 使用）`,
  };
}

export async function runDoctor(options: { settings?: string; json?: boolean }): Promise<number> {
  const paths = getPaths();
  const settingsPath = options.settings ?? getClaudeSettingsPath();
  const checks: Check[] = [];
  checks.push(checkNode());
  checks.push(checkGit());
  const claude = checkClaude();
  checks.push(claude.check);
  const sqlite = checkSqlite();
  const database = sqlite.status === 'ok' ? checkDatabase(paths.dbFile) : { check: undefined, lastEvent: null };
  checks.push(...checkHooks(settingsPath, claude.version, database.lastEvent));
  checks.push(sqlite);
  if (database.check) checks.push(database.check);
  checks.push(checkConfig(paths.configFile));
  checks.push(checkPermissions([paths.dataDir, paths.logsDir, paths.reportsDir], settingsPath));
  checks.push(checkErrors(paths.logFile));

  const failed = checks.filter((ch) => ch.status === 'fail').length;
  const warned = checks.filter((ch) => ch.status === 'warn').length;

  if (options.json) {
    process.stdout.write(JSON.stringify({ checks, failed, warned }, null, 2) + '\n');
    return failed > 0 ? 1 : 0;
  }

  console.log(c.bold('DevTrack Doctor'));
  console.log('');
  const width = Math.max(...checks.map((ch) => ch.name.length)) + 2;
  for (const ch of checks) {
    const icon = ch.status === 'ok' ? c.green('✔') : ch.status === 'warn' ? c.yellow('⚠') : c.red('✖');
    console.log(`  ${icon} ${padEnd(ch.name, width)}${ch.message}`);
    if (ch.fix && ch.status !== 'ok') console.log(`    ${' '.repeat(width)}${c.cyan('→ 解决：')}${ch.fix}`);
  }
  console.log('');
  const passed = checks.length - failed - warned;
  const summary = `${passed} 项通过，${warned} 项警告，${failed} 项失败`;
  console.log(failed > 0 ? c.red(summary) : warned > 0 ? c.yellow(summary) : c.green(summary));
  return failed > 0 ? 1 : 0;
}
