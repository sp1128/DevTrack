import fs from 'node:fs';
import { ConfigError, defaultConfig, loadConfig, saveConfig } from '../../config.js';
import { compareVersions, getClaudeCodeVersion, MIN_VERSION_EXEC_FORM } from '../../core/claude.js';
import { openDatabase } from '../../db/database.js';
import { installHooks, SettingsError, type HookCommandMode } from '../../hooks/install.js';
import { getClaudeSettingsPath, getPaths, tildify } from '../../paths.js';
import { CliError } from '../context.js';
import { c } from '../format.js';

export interface InitOptions {
  hooks: boolean;
  hookCommand: HookCommandMode;
  settings?: string;
  enableTaskTools?: boolean;
}

export async function runInit(options: InitOptions): Promise<void> {
  const paths = getPaths();
  const ok = (label: string, detail: string) => console.log(`  ${c.green('✔')} ${label}  ${c.gray(detail)}`);
  const warn = (label: string, detail: string) => console.log(`  ${c.yellow('!')} ${label}  ${detail}`);

  console.log(c.bold('初始化 DevTrack'));
  console.log('');

  for (const dir of [paths.dataDir, paths.logsDir, paths.reportsDir]) fs.mkdirSync(dir, { recursive: true });
  ok('数据目录', tildify(paths.dataDir));

  if (fs.existsSync(paths.configFile)) {
    try {
      loadConfig(paths.configFile);
      ok('配置文件', `${tildify(paths.configFile)}（已存在，保持不变）`);
    } catch (err) {
      warn('配置文件', `${(err as ConfigError).message}，Hook 将暂时使用默认配置`);
    }
  } else {
    saveConfig(defaultConfig(), paths.configFile);
    ok('配置文件', tildify(paths.configFile));
  }

  const db = openDatabase(paths.dbFile);
  db.close();
  ok('数据库', tildify(paths.dbFile));

  if (!options.hooks) {
    warn('Claude Code Hooks', '已跳过（--no-hooks）。之后可运行 devtrack init 安装。');
  } else {
    const settingsPath = options.settings ?? getClaudeSettingsPath();
    try {
      const result = installHooks({
        settingsPath,
        backupDir: paths.backupsDir,
        mode: options.hookCommand,
        enableTaskTools: options.enableTaskTools,
      });
      ok(
        'Claude Code Hooks',
        `${tildify(result.settingsPath)}${result.changed ? '' : '（已是最新）'}${result.backupPath ? `，原文件已备份到 ${tildify(result.backupPath)}` : ''}`,
      );
      console.log(c.gray(`      事件：${result.events.join(', ')}`));
      if (options.enableTaskTools) console.log(c.gray('      已设置 env.CLAUDE_CODE_ENABLE_TODO_TOOLS=1（启用任务工具，便于识别开发任务）'));
    } catch (err) {
      if (err instanceof SettingsError) throw new CliError(err.message);
      throw err;
    }
    if (options.hookCommand === 'node') {
      const { version } = getClaudeCodeVersion();
      if (version && compareVersions(version, MIN_VERSION_EXEC_FORM) < 0) {
        warn(
          'Claude Code 版本',
          `当前 ${version} 低于 ${MIN_VERSION_EXEC_FORM}，不支持 exec 形式的 Hook。请升级 Claude Code，或运行 devtrack init --hook-command path`,
        );
      }
    }
  }

  console.log('');
  console.log(c.bold('下一步'));
  console.log(`  1. 重新启动 Claude Code（已经打开的会话不会加载新的 Hook）`);
  console.log(`  2. 像平常一样使用 ${c.cyan('claude')}，DevTrack 会在后台自动记录`);
  console.log(`  3. 运行 ${c.cyan('devtrack today')} 查看今天，${c.cyan('devtrack doctor')} 检查安装状态`);
  console.log('');
}
