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

  // 输出语言：--lang 参数 > DEVTRACK_LANG 环境变量 > 配置 lang
  const { isLang, setLang } = await import('./i18n.js');
  program.addOption(new Option('--lang <lang>', '输出语言：zh（中文）或 en（英文），默认读取配置 lang').choices(['zh', 'en']));
  program.hook('preAction', () => {
    const lang = program.opts<{ lang?: string }>().lang ?? process.env.DEVTRACK_LANG;
    if (isLang(lang)) setLang(lang, true);
  });

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
    .description('生成 Markdown 周报 / 月报到 ~/.devtrack/reports/（<年>-W<周>.md 或 <年>-<月>.md）')
    .option('--last', '生成上周（与 --month 一起使用时为上月）的报告')
    .option('--week <YYYY-Www>', '生成指定 ISO 周的周报')
    .option('--month [YYYY-MM]', '生成月报：不带值为本月，也可以指定月份')
    .option('--ai', '调用 AI 生成总结（需配置 ai.provider 与 API Key，只发送统计数据）')
    .option('--dry-run', '与 --ai 一起使用：只打印将发送给 AI 的数据，不实际调用')
    .option('-o, --output <file>', '输出文件路径')
    .option('--stdout', '输出到终端而不是文件')
    .option('--send', '生成后把摘要推送到已配置的聊天工具（devtrack notify add）')
    .addOption(new Option('--auto', '由 Hook 自动调用：静默生成上周周报，不覆盖已有文件').hideHelp())
    .addOption(noSync())
    .action(
      action(async (opts) => {
        const { runReport } = await import('./cli/commands/report.js');
        return runReport(opts);
      }),
    );

  program
    .command('standup')
    .description('站会摘要：上一个工作日与今天做了什么、遇到的问题，可直接粘贴到聊天工具')
    .option('--date <YYYY-MM-DD>', '以指定日期为"今天"')
    .option('--ai', '用 AI 把摘要改写成自然的站会发言（只发送提交说明、摘要等统计数据）')
    .option('--dry-run', '与 --ai 一起使用：只打印将发送给 AI 的数据，不实际调用')
    .option('--json', '以 JSON 输出')
    .option('--send', '同时推送到已配置的聊天工具（devtrack notify add）')
    .addOption(noSync())
    .action(
      action(async (opts) => {
        const { runStandup } = await import('./cli/commands/standup.js');
        return runStandup(opts);
      }),
    );

  const notify = program.command('notify').description('推送站会摘要与周报到 Slack / Discord / 飞书 / 钉钉 / 企业微信 / 通用 Webhook');
  notify
    .command('list', { isDefault: true })
    .description('列出推送目标（地址中的令牌已隐藏）')
    .action(
      action(async () => {
        const { runNotifyList } = await import('./cli/commands/notify.js');
        await runNotifyList();
      }),
    );
  notify
    .command('add <type> [url]')
    .description('添加推送目标，type 为 slack / discord / feishu / dingtalk / wecom / webhook')
    .option('--name <name>', '便于识别的名称')
    .option('--url-env <VAR>', '从环境变量读取 Webhook 地址（不写入配置文件）')
    .option('--secret <secret>', '钉钉"加签"密钥')
    .option('--secret-env <VAR>', '从环境变量读取钉钉"加签"密钥')
    .action(
      action(async (type: string, url: string | undefined, opts) => {
        const { runNotifyAdd } = await import('./cli/commands/notify.js');
        await runNotifyAdd(type, url, opts);
      }),
    );
  notify
    .command('remove <name-or-number>')
    .description('删除推送目标（名称或 notify list 中的序号）')
    .action(
      action(async (which: string) => {
        const { runNotifyRemove } = await import('./cli/commands/notify.js');
        await runNotifyRemove(which);
      }),
    );
  notify
    .command('test')
    .description('向所有推送目标发送一条测试消息')
    .action(
      action(async () => {
        const { runNotifyTest } = await import('./cli/commands/notify.js');
        return runNotifyTest();
      }),
    );

  const mcp = program.command('mcp').description('MCP 服务器：让 Claude Code 直接查询 DevTrack 的统计数据（只读）');
  mcp
    .command('serve', { isDefault: true })
    .description('以 stdio 方式运行 MCP 服务器（由 Claude Code 启动）')
    .action(
      action(async () => {
        const { runMcpServe } = await import('./cli/commands/mcp.js');
        await runMcpServe();
      }),
    );
  mcp
    .command('install')
    .description('通过 claude mcp add 注册到 Claude Code')
    .option('--name <name>', 'MCP 服务器名称', 'devtrack-stats')
    .option('--scope <scope>', 'user（所有项目，默认）/ local / project', 'user')
    .action(
      action(async (opts: { name?: string; scope?: string }) => {
        const { runMcpInstall } = await import('./cli/commands/mcp.js');
        return runMcpInstall(opts);
      }),
    );
  mcp
    .command('uninstall')
    .description('从 Claude Code 移除 MCP 服务器')
    .option('--name <name>', 'MCP 服务器名称', 'devtrack-stats')
    .option('--scope <scope>', 'user / local / project', 'user')
    .action(
      action(async (opts: { name?: string; scope?: string }) => {
        const { runMcpUninstall } = await import('./cli/commands/mcp.js');
        return runMcpUninstall(opts);
      }),
    );
  mcp
    .command('test')
    .description('自检：模拟 Claude Code 调用每个工具')
    .action(
      action(async () => {
        const { runMcpTest } = await import('./cli/commands/mcp.js');
        return runMcpTest();
      }),
    );

  program
    .command('heatmap')
    .description('终端热力图：类似 GitHub 贡献图，显示最近一年每天的开发活跃度')
    .option('--weeks <n>', '显示最近多少周（默认按终端宽度，最多 53 周）')
    .option('--metric <metric>', '按什么统计：time（开发时长，默认）/ commits（提交）/ sessions（会话）')
    .option('--json', '以 JSON 输出每日数据')
    .addOption(noSync())
    .action(
      action(async (opts) => {
        const { runHeatmap } = await import('./cli/commands/heatmap.js');
        await runHeatmap(opts);
      }),
    );

  program
    .command('export')
    .description('导出数据为 CSV 或 JSON，方便导入 Excel 或其他工具')
    .option('--format <format>', 'csv 或 json', 'csv')
    .option(
      '--type <type>',
      '导出的数据：sessions / daily / projects / commits / files / commands / tasks / tokens（JSON 不指定时导出全部）',
    )
    .option('--since <range>', '起始时间，例如 30d、12w、2026-01-01（默认全部记录）')
    .option('--until <date>', '截止日期（不含），例如 2026-10-01（默认现在）')
    .option('-o, --output <file>', '输出文件（默认输出到终端）')
    .addOption(noSync())
    .action(
      action(async (opts) => {
        const { runExport } = await import('./cli/commands/export.js');
        await runExport(opts);
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
