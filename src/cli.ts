#!/usr/bin/env node
import module, { createRequire } from 'node:module';

// 缓存编译后的字节码（Node 22.1+），显著降低 Hook 每次启动的开销
try {
  module.enableCompileCache?.();
} catch {
  // 不支持时忽略
}

// Hook 快速路径：由 Claude Code 高频调用，只加载必要模块，也不解析命令行
if (process.argv[2] === 'hook') {
  const { runHook } = await import('./hooks/runner.js');
  await runHook();
} else {
  await main();
}

async function main(): Promise<void> {
  const { Command, Option } = await import('commander');
  const { CliError } = await import('./cli/context.js');
  const { c } = await import('./cli/format.js');
  const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

  /** 包装命令：统一处理错误输出与退出码。 */
  const action =
    <A extends unknown[]>(fn: (...args: A) => Promise<number | void>) =>
    async (...args: A): Promise<void> => {
      try {
        const code = await fn(...args);
        if (typeof code === 'number') process.exitCode = code;
      } catch (err) {
        if (err instanceof CliError) {
          console.error(c.red(`错误：${err.message}`));
          process.exitCode = err.exitCode;
        } else {
          console.error(c.red(`错误：${(err as Error)?.message ?? String(err)}`));
          if (process.env.DEVTRACK_DEBUG) console.error(err);
          process.exitCode = 1;
        }
      }
    };

  const program = new Command();
  program
    .name('devtrack')
    .description('DevTrack：本地自动统计 Claude Code 开发活动（会话、文件、命令、Git 提交、任务），生成开发周报')
    .version(pkg.version, '-v, --version', '显示版本号')
    .helpOption('-h, --help', '显示帮助')
    .helpCommand('help [command]', '显示命令帮助')
    .showHelpAfterError('(使用 devtrack --help 查看可用命令)');

  const noSync = () => new Option('--no-sync', '跳过查询前的 Git 提交同步');

  program
    .command('init')
    .description('初始化数据目录、数据库，并把 Hook 安装到 ~/.claude/settings.json')
    .option('--no-hooks', '只初始化数据目录，不安装 Claude Code Hook')
    .addOption(
      new Option('--hook-command <mode>', 'Hook 调用方式：node=node 绝对路径（默认），path=通过 PATH 调用 devtrack')
        .choices(['node', 'path'])
        .default('node'),
    )
    .option('--settings <file>', 'Claude Code 设置文件路径（默认 ~/.claude/settings.json）')
    .option('--enable-task-tools', '同时设置 CLAUDE_CODE_ENABLE_TODO_TOOLS=1，让新模型也使用任务工具，提升任务识别')
    .action(
      action(async (opts: { hooks: boolean; hookCommand: 'node' | 'path'; settings?: string; enableTaskTools?: boolean }) => {
        const { runInit } = await import('./cli/commands/init.js');
        await runInit(opts);
      }),
    );

  program
    .command('doctor')
    .description('检查 Node.js、Git、Claude Code、Hooks、SQLite、数据库、配置与文件权限')
    .option('--settings <file>', 'Claude Code 设置文件路径')
    .option('--json', '以 JSON 输出')
    .action(
      action(async (opts: { settings?: string; json?: boolean }) => {
        const { runDoctor } = await import('./cli/commands/doctor.js');
        return runDoctor(opts);
      }),
    );

  program
    .command('today')
    .description('今天的开发情况：时长、会话、项目、文件、提交、任务')
    .option('--yesterday', '查看昨天')
    .option('--date <YYYY-MM-DD>', '查看指定日期')
    .option('--json', '以 JSON 输出')
    .addOption(noSync())
    .action(
      action(async (opts) => {
        const { runToday } = await import('./cli/commands/period.js');
        await runToday(opts);
      }),
    );

  program
    .command('week')
    .description('本周（周一至周日）的开发情况与各项目开发时间')
    .option('--last', '查看上周')
    .option('--week <YYYY-Www>', '查看指定 ISO 周，例如 2026-W39')
    .option('--json', '以 JSON 输出')
    .addOption(noSync())
    .action(
      action(async (opts) => {
        const { runWeek } = await import('./cli/commands/period.js');
        await runWeek(opts);
      }),
    );

  program
    .command('month')
    .description('本月的开发情况')
    .option('--last', '查看上月')
    .option('--month <YYYY-MM>', '查看指定月份')
    .option('--json', '以 JSON 输出')
    .addOption(noSync())
    .action(
      action(async (opts) => {
        const { runMonth } = await import('./cli/commands/period.js');
        await runMonth(opts);
      }),
    );

  program
    .command('project [name]')
    .description('不带参数列出所有项目；指定项目名 / 路径（. 表示当前目录）查看该项目的开发统计')
    .option('--since <range>', '统计范围，例如 7d、4w、3m、2026-09-01（默认全部记录）')
    .option('--json', '以 JSON 输出')
    .addOption(noSync())
    .action(
      action(async (name: string | undefined, opts) => {
        const { runProject } = await import('./cli/commands/project.js');
        await runProject(name, opts);
      }),
    );

  program
    .command('report')
    .description('生成 Markdown 周报到 ~/.devtrack/reports/<年>-W<周>.md')
    .option('--last', '生成上周的周报')
    .option('--week <YYYY-Www>', '生成指定 ISO 周的周报')
    .option('--ai', '调用 AI 生成总结（需配置 ai.provider 与 API Key，只发送统计数据）')
    .option('--dry-run', '与 --ai 一起使用：只打印将发送给 AI 的数据，不实际调用')
    .option('-o, --output <file>', '输出文件路径')
    .option('--stdout', '输出到终端而不是文件')
    .addOption(noSync())
    .action(
      action(async (opts) => {
        const { runReport } = await import('./cli/commands/report.js');
        await runReport(opts);
      }),
    );

  program
    .command('summarize')
    .description('用 AI 为已结束的会话生成一句话摘要（只发送会话的统计数据，不发送对话内容与源代码）')
    .option('--since <range>', '只处理该时间之后开始的会话，例如 7d、4w、2026-09-01', '7d')
    .option('--session <id>', '只处理指定的 Claude Code 会话 ID')
    .option('--force', '重新生成已有摘要')
    .option('--limit <n>', '最多处理多少个会话', '20')
    .option('--dry-run', '只打印将发送给 AI 的数据，不实际调用')
    .option('--quiet', '不输出内容，错误只写入日志（Hook 自动调用时使用）')
    .action(
      action(async (opts) => {
        const { runSummarize } = await import('./cli/commands/summarize.js');
        await runSummarize(opts);
      }),
    );

  program
    .command('stats')
    .description('全部记录的总体统计：累计时长、项目、提交、常用工具、命令类别')
    .option('--json', '以 JSON 输出')
    .addOption(noSync())
    .action(
      action(async (opts) => {
        const { runStats } = await import('./cli/commands/stats.js');
        await runStats(opts);
      }),
    );

  program
    .command('purge')
    .description('删除指定时间之前的数据，例如 devtrack purge --before 30d')
    .requiredOption('--before <range>', '截止时间：30d、12w、6m、1y 或 YYYY-MM-DD')
    .option('--dry-run', '只显示将删除的数量')
    .option('-y, --yes', '跳过确认')
    .action(
      action(async (opts: { before: string; dryRun?: boolean; yes?: boolean }) => {
        const { runPurge } = await import('./cli/commands/data.js');
        await runPurge(opts);
      }),
    );

  program
    .command('reset')
    .description('删除所有已采集的数据（保留配置）；--all 删除整个 ~/.devtrack 目录')
    .option('--all', '同时删除配置文件与备份')
    .option('-y, --yes', '跳过确认')
    .action(
      action(async (opts: { all?: boolean; yes?: boolean }) => {
        const { runReset } = await import('./cli/commands/data.js');
        await runReset(opts);
      }),
    );

  program
    .command('uninstall')
    .description('从 ~/.claude/settings.json 移除 DevTrack Hook（默认保留数据）')
    .option('--settings <file>', 'Claude Code 设置文件路径')
    .option('--purge', '同时删除 ~/.devtrack 下的全部数据')
    .option('-y, --yes', '跳过确认')
    .action(
      action(async (opts: { settings?: string; purge?: boolean; yes?: boolean }) => {
        const { runUninstall } = await import('./cli/commands/data.js');
        await runUninstall(opts);
      }),
    );

  const config = program.command('config').description('查看或修改配置（~/.devtrack/config.json）');
  config
    .command('list', { isDefault: true })
    .description('显示当前配置')
    .action(
      action(async () => {
        const { runConfigList } = await import('./cli/commands/config.js');
        await runConfigList();
      }),
    );
  config
    .command('get <key>')
    .description('读取配置项，例如 devtrack config get collect.commands')
    .action(
      action(async (key: string) => {
        const { runConfigGet } = await import('./cli/commands/config.js');
        await runConfigGet(key);
      }),
    );
  config
    .command('set <key> <value>')
    .description('修改配置项，例如 devtrack config set collect.commands false')
    .action(
      action(async (key: string, value: string) => {
        const { runConfigSet } = await import('./cli/commands/config.js');
        await runConfigSet(key, value);
      }),
    );
  config
    .command('unset <key>')
    .description('清除可选配置项（ai.model、ai.baseUrl、ai.apiKeyEnv、ai.sessionSummaryModel）')
    .action(
      action(async (key: string) => {
        const { runConfigUnset } = await import('./cli/commands/config.js');
        await runConfigUnset(key);
      }),
    );
  config
    .command('reset')
    .description('恢复默认配置')
    .action(
      action(async () => {
        const { runConfigReset } = await import('./cli/commands/config.js');
        await runConfigReset();
      }),
    );
  config
    .command('path')
    .description('显示配置文件路径')
    .action(
      action(async () => {
        const { runConfigPath } = await import('./cli/commands/config.js');
        await runConfigPath();
      }),
    );

  await program.parseAsync(process.argv);
}
