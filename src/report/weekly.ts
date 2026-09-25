import { categoryLabel } from '../core/commands.js';
import { formatCost, formatDuration, formatNumber, formatTokens, percent, shortHash } from '../core/format.js';
import { formatDate, formatDateTime, weekdayLabel } from '../core/time.js';
import { getLang, L } from '../i18n.js';
import type { PeriodStats } from '../stats/queries.js';

export type ReportPeriod = 'week' | 'month';

export interface ReportOptions {
  generatedAt: Date;
  /** 周报（默认）或月报 */
  period?: ReportPeriod;
  aiSummary?: { text: string; provider: string; model: string };
  /** AI 生成失败时的说明 */
  aiError?: string;
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/** Markdown 表格单元格转义 */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** 行内代码，避免内容中的反引号破坏格式 */
function code(text: string): string {
  const ticks = text.includes('`') ? '``' : '`';
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

function table(headers: string[], rows: string[][]): string[] {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ];
}

export function buildWeeklyReport(stats: PeriodStats, options: ReportOptions): string {
  const period = options.period ?? 'week';
  const en = getLang() === 'en';
  const week = period === 'week';
  /** 本周 / 本月 */
  const P = week ? L('本周', 'this week') : L('本月', 'this month');
  /** 句首的 This week / This month */
  const Pc = en ? P[0]!.toUpperCase() + P.slice(1) : P;
  const start = new Date(stats.range.start);
  const lastDay = new Date(new Date(stats.range.end).getTime() - 1);
  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);
  const day = (d: Date) => (en ? `${formatDate(d)} (${weekdayLabel(d)})` : `${formatDate(d)}（${weekdayLabel(d)}）`);

  push(
    L(`# DevTrack 开发${week ? '周报' : '月报'} · ${stats.range.label}`, `# DevTrack ${week ? 'Weekly' : 'Monthly'} Report · ${stats.range.label}`),
    '',
  );
  push(
    L(
      `> 统计区间：${day(start)}至 ${day(lastDay)} · 生成时间：${formatDateTime(options.generatedAt)}`,
      `> Period: ${day(start)} to ${day(lastDay)} · Generated: ${formatDateTime(options.generatedAt)}`,
    ),
    '',
  );

  // 一、概况
  push(L(`## 一、${P}开发概况`, `## 1. Overview`), '');
  const t = stats.commitTotals;
  push(
    ...table(
      L('指标|数值', 'Metric|Value').split('|'),
      [
        [L('开发时长（活跃）', 'Active time'), formatDuration(stats.activeSeconds)],
        [L('活跃天数', 'Active days'), L(`${stats.activeDays} 天`, String(stats.activeDays))],
        [
          L('Claude 会话', 'Claude sessions'),
          L(`${stats.sessions.length} 个（提示词 ${stats.prompts} 条）`, `${stats.sessions.length} (${stats.prompts} prompts)`),
        ],
        [L('涉及项目', 'Projects'), L(`${stats.projects.length} 个`, String(stats.projects.length))],
        [
          L('Git 提交', 'Git commits'),
          L(
            `${t.count} 次（+${formatNumber(t.insertions)} / -${formatNumber(t.deletions)} 行）`,
            `${t.count} (+${formatNumber(t.insertions)} / -${formatNumber(t.deletions)} lines)`,
          ),
        ],
        [
          L('修改文件', 'Files modified'),
          L(
            `${stats.files.distinct} 个（${stats.files.edits} 次修改，新增 ${stats.files.created} 个）`,
            `${stats.files.distinct} (${stats.files.edits} edits, ${stats.files.created} created)`,
          ),
        ],
        [
          L('执行命令', 'Commands run'),
          L(`${stats.commands.total} 次（失败 ${stats.commands.failed} 次）`, `${stats.commands.total} (${stats.commands.failed} failed)`),
        ],
        [L('完成任务', 'Tasks completed'), L(`${stats.tasks.completed.length} 个`, String(stats.tasks.completed.length))],
        ...(stats.tokens
          ? [[L('Token / 估算费用', 'Tokens / estimated cost'), `${formatTokens(stats.tokens.total)} / ${formatCost(stats.tokens.cost)}`]]
          : []),
      ],
    ),
    '',
  );
  if (stats.daily.some((d) => d.activeSeconds > 0 || d.commits > 0 || d.fileEdits > 0)) {
    push(L('### 每日分布', '### Daily breakdown'), '');
    push(
      ...table(
        L('日期|开发时长|会话|提交|文件修改|命令', 'Date|Active time|Sessions|Commits|File edits|Commands').split('|'),
        stats.daily.map((d) => [
          day(new Date(`${d.date}T00:00:00`)),
          d.activeSeconds > 0 ? formatDuration(d.activeSeconds) : '-',
          String(d.sessions),
          String(d.commits),
          String(d.fileEdits),
          String(d.commands),
        ]),
      ),
      '',
    );
  }

  if (stats.tokens) {
    push(L('### Token 用量', '### Token usage'), '');
    push(
      ...table(
        L('模型|请求|输入|输出|缓存读取|缓存写入|估算费用', 'Model|Requests|Input|Output|Cache read|Cache write|Estimated cost').split('|'),
        stats.tokens.byModel.map((m) => [
          m.model,
          formatNumber(m.messages),
          formatTokens(m.input),
          formatTokens(m.output),
          formatTokens(m.cacheRead),
          formatTokens(m.cacheWrite),
          m.cost === null ? L('价格未知', 'unknown price') : formatCost(m.cost),
        ]),
      ),
      '',
      L(
        '> 费用按 Anthropic 公开标价估算，仅供参考；订阅套餐（Pro / Max）不按 token 计费。',
        '> Estimated from Anthropic list prices, for reference only; subscription plans (Pro / Max) are not billed per token.',
      ),
      '',
    );
  }

  // 二、项目
  push(L('## 二、项目', '## 2. Projects'), '');
  if (stats.projects.length === 0) {
    push(L(`${P}没有记录到项目活动。`, `No project activity recorded ${P}.`), '');
  } else {
    push(
      ...table(
        L('项目|开发时长|会话|提交|代码行|文件|完成任务', 'Project|Active time|Sessions|Commits|Lines|Files|Tasks done').split('|'),
        stats.projects.map((p) => [
          p.name,
          formatDuration(p.activeSeconds),
          String(p.sessions),
          String(p.commits),
          `+${formatNumber(p.insertions)} / -${formatNumber(p.deletions)}`,
          String(p.files),
          String(p.tasksCompleted),
        ]),
      ),
      '',
    );
    for (const p of stats.projects) {
      push(`### ${p.name}`, '');
      push(L(`- 路径：${code(p.path)}`, `- Path: ${code(p.path)}`));
      if (p.gitRemote) push(L(`- 远程仓库：${p.gitRemote}`, `- Remote: ${p.gitRemote}`));
      push(
        L(
          `- 开发时长 ${formatDuration(p.activeSeconds)}，会话 ${p.sessions} 个，提交 ${p.commits} 次，修改文件 ${p.files} 个，执行命令 ${p.commands} 次（失败 ${p.commandFailures} 次）`,
          `- Active time ${formatDuration(p.activeSeconds)}, ${p.sessions} sessions, ${p.commits} commits, ${p.files} files modified, ${p.commands} commands (${p.commandFailures} failed)`,
        ),
      );
      const files = stats.files.top.filter((f) => f.projectId === p.id).slice(0, 5);
      if (files.length > 0) {
        push(
          L(
            `- 主要修改：${files.map((f) => `${code(f.path)}（${f.edits}）`).join('、')}`,
            `- Main changes: ${files.map((f) => `${code(f.path)} (${f.edits})`).join(', ')}`,
          ),
        );
      }
      const summaries = stats.sessions.filter((sess) => sess.projectId === p.id && sess.summary);
      if (summaries.length > 0) {
        push(L('- 会话摘要：', '- Session summaries:'));
        for (const sess of summaries) push(`  - ${weekdayLabel(new Date(sess.startedAt))}${L('：', ': ')}${sess.summary}`);
      }
      push('');
    }
  }

  // 三、完成任务
  push(L('## 三、完成任务', '## 3. Completed tasks'), '');
  if (stats.tasks.completed.length > 0) {
    for (const task of stats.tasks.completed) {
      const when = task.completedAt ? weekdayLabel(new Date(task.completedAt)) : '';
      push(L(`- [x] ${task.title}（${task.projectName}${when ? `，${when}` : ''}）`, `- [x] ${task.title} (${task.projectName}${when ? `, ${when}` : ''})`));
    }
    if (stats.tasks.open > 0) {
      push('', L(`另有 ${stats.tasks.open} 个${P}创建的任务尚未完成。`, `${stats.tasks.open} more tasks created ${P} are still open.`));
    }
    push('');
  } else if (stats.commits.length > 0) {
    push(
      L(
        `${P}没有记录到 Claude 任务清单（新版模型默认不启用任务工具），以下根据 Git 提交推断：`,
        `No Claude task lists were recorded ${P} (newer models don't use task tools by default); inferred from Git commits:`,
      ),
      '',
    );
    for (const c of [...stats.commits].reverse().slice(0, 30)) {
      const when = weekdayLabel(new Date(c.timestamp));
      push(L(`- [x] ${c.message}（${c.projectName}，${when}）`, `- [x] ${c.message} (${c.projectName}, ${when})`));
    }
    push('');
  } else {
    push(L(`${P}没有记录到已完成的任务。`, `No completed tasks recorded ${P}.`), '');
  }

  // 四、Git 活动
  push(L('## 四、Git 活动', '## 4. Git activity'), '');
  if (stats.commits.length === 0) {
    push(L(`${P}没有 Git 提交。`, `No Git commits ${P}.`), '');
  } else {
    const withClaude = stats.commits.filter((c) => c.withClaude).length;
    push(
      L(
        `共 ${t.count} 次提交，涉及 ${formatNumber(t.filesChanged)} 个文件变更，+${formatNumber(t.insertions)} / -${formatNumber(t.deletions)} 行；其中 ${withClaude} 次提交发生在 Claude 会话期间。`,
        `${t.count} commits, ${formatNumber(t.filesChanged)} file changes, +${formatNumber(t.insertions)} / -${formatNumber(t.deletions)} lines; ${withClaude} commits were made during Claude sessions.`,
      ),
      '',
    );
    push(
      ...table(
        L('时间|项目|分支|提交|说明|变更', 'Time|Project|Branch|Commit|Message|Changes').split('|'),
        [...stats.commits].reverse().map((c) => [
          formatDateTime(new Date(c.timestamp)),
          c.projectName,
          c.branch ?? '-',
          code(shortHash(c.hash)),
          c.message,
          L(`${c.filesChanged} 文件，+${c.insertions} / -${c.deletions}`, `${c.filesChanged} files, +${c.insertions} / -${c.deletions}`),
        ]),
      ),
      '',
    );
  }

  // 五、文件修改
  push(L('## 五、文件修改', '## 5. File changes'), '');
  if (stats.files.distinct === 0) {
    push(L(`${P}没有记录到文件修改。`, `No file changes recorded ${P}.`), '');
  } else {
    push(
      L(
        `共修改 ${stats.files.distinct} 个文件（${stats.files.edits} 次修改），其中新增 ${stats.files.created} 个、删除 ${stats.files.deleted} 个。`,
        `${stats.files.distinct} files modified (${stats.files.edits} edits), ${stats.files.created} created, ${stats.files.deleted} deleted.`,
      ),
      '',
    );
    push(
      ...table(
        L('项目|文件|修改次数', 'Project|File|Edits').split('|'),
        stats.files.top.map((f) => [f.projectName, code(f.path), String(f.edits)]),
      ),
      '',
    );
  }

  // 六、技术问题
  push(L('## 六、技术问题', '## 6. Technical issues'), '');
  const issues: string[] = [];
  for (const cat of stats.commands.byCategory) {
    if (cat.failed > 0) {
      issues.push(
        L(
          `- ${categoryLabel(cat.category)}命令执行 ${cat.total} 次，失败 ${cat.failed} 次（失败率 ${percent(cat.failed, cat.total)}）`,
          `- ${categoryLabel(cat.category)} commands: ${cat.total} runs, ${cat.failed} failed (${percent(cat.failed, cat.total)} failure rate)`,
        ),
      );
    }
  }
  const failures = stats.commands.failures.slice(0, 10);
  if (failures.length > 0) {
    issues.push('', L('失败次数最多的命令：', 'Most frequently failing commands:'), '');
    for (const f of failures) {
      const exit = f.lastExitCode !== null ? L(`，最近退出码 ${f.lastExitCode}`, `, last exit code ${f.lastExitCode}`) : '';
      issues.push(L(`- ${code(f.command)}（${f.projectName}）失败 ${f.count} 次${exit}`, `- ${code(f.command)} (${f.projectName}) failed ${f.count} times${exit}`));
    }
  }
  const toolFailures = stats.tools.filter((tool) => tool.failures > 0 && !SHELL_TOOLS.has(tool.tool));
  if (toolFailures.length > 0) {
    issues.push(
      '',
      L(
        `工具调用失败：${toolFailures.map((tool) => `${tool.tool} ${tool.failures} 次`).join('，')}`,
        `Tool call failures: ${toolFailures.map((tool) => `${tool.tool} ${tool.failures}`).join(', ')}`,
      ),
    );
  }
  if (issues.length === 0) {
    push(L(`${P}未检测到失败的构建、测试命令或工具调用。`, `${Pc}: no failed builds, test commands or tool calls detected.`), '');
  } else push(...issues, '');

  // 七、AI 总结
  if (options.aiSummary) {
    push(L('## 七、AI 总结', '## 7. AI summary'), '');
    push(options.aiSummary.text.trim(), '');
    push(
      L(
        `> 由 ${options.aiSummary.provider}（${options.aiSummary.model}）根据以上统计数据生成，仅发送了统计数字与任务摘要，未发送源代码。`,
        `> Generated by ${options.aiSummary.provider} (${options.aiSummary.model}) from the statistics above; only numbers and task summaries were sent, no source code.`,
      ),
      '',
    );
  } else if (options.aiError) {
    push(L('## 七、AI 总结', '## 7. AI summary'), '');
    push(L(`> AI 总结生成失败：${options.aiError}`, `> AI summary failed: ${options.aiError}`), '');
  }

  push('---', '');
  push(
    L(
      '*由 DevTrack 自动生成，数据仅保存在本机。开发时长为活跃时长：同一会话内相邻活动间隔超过空闲阈值的时间不计入。*',
      '*Generated by DevTrack; all data stays on this machine. Active time excludes gaps between activities in a session longer than the idle threshold.*',
    ),
    '',
  );
  return lines.join('\n');
}
