import { CATEGORY_LABELS, type CommandCategory } from '../core/commands.js';
import { formatCost, formatDuration, formatNumber, formatTokens, percent, shortHash } from '../core/format.js';
import { formatDate, formatDateTime, weekdayLabel } from '../core/time.js';
import type { PeriodStats } from '../stats/queries.js';

export interface ReportOptions {
  generatedAt: Date;
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

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category as CommandCategory] ?? category;
}

export function buildWeeklyReport(stats: PeriodStats, options: ReportOptions): string {
  const start = new Date(stats.range.start);
  const lastDay = new Date(new Date(stats.range.end).getTime() - 1);
  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);

  push(`# DevTrack 开发周报 · ${stats.range.label}`, '');
  push(
    `> 统计区间：${formatDate(start)}（${weekdayLabel(start)}）至 ${formatDate(lastDay)}（${weekdayLabel(lastDay)}） · 生成时间：${formatDateTime(options.generatedAt)}`,
    '',
  );

  // 一、概况
  push('## 一、本周开发概况', '');
  const t = stats.commitTotals;
  push(
    ...table(
      ['指标', '数值'],
      [
        ['开发时长（活跃）', formatDuration(stats.activeSeconds)],
        ['活跃天数', `${stats.activeDays} 天`],
        ['Claude 会话', `${stats.sessions.length} 个（提示词 ${stats.prompts} 条）`],
        ['涉及项目', `${stats.projects.length} 个`],
        ['Git 提交', `${t.count} 次（+${formatNumber(t.insertions)} / -${formatNumber(t.deletions)} 行）`],
        ['修改文件', `${stats.files.distinct} 个（${stats.files.edits} 次修改，新增 ${stats.files.created} 个）`],
        ['执行命令', `${stats.commands.total} 次（失败 ${stats.commands.failed} 次）`],
        ['完成任务', `${stats.tasks.completed.length} 个`],
        ...(stats.tokens
          ? [['Token / 估算费用', `${formatTokens(stats.tokens.total)} / ${formatCost(stats.tokens.cost)}`]]
          : []),
      ],
    ),
    '',
  );
  if (stats.daily.some((d) => d.activeSeconds > 0 || d.commits > 0 || d.fileEdits > 0)) {
    push('### 每日分布', '');
    push(
      ...table(
        ['日期', '开发时长', '会话', '提交', '文件修改', '命令'],
        stats.daily.map((d) => {
          const date = new Date(`${d.date}T00:00:00`);
          return [
            `${d.date}（${weekdayLabel(date)}）`,
            d.activeSeconds > 0 ? formatDuration(d.activeSeconds) : '-',
            String(d.sessions),
            String(d.commits),
            String(d.fileEdits),
            String(d.commands),
          ];
        }),
      ),
      '',
    );
  }

  if (stats.tokens) {
    push('### Token 用量', '');
    push(
      ...table(
        ['模型', '请求', '输入', '输出', '缓存读取', '缓存写入', '估算费用'],
        stats.tokens.byModel.map((m) => [
          m.model,
          formatNumber(m.messages),
          formatTokens(m.input),
          formatTokens(m.output),
          formatTokens(m.cacheRead),
          formatTokens(m.cacheWrite),
          m.cost === null ? '价格未知' : formatCost(m.cost),
        ]),
      ),
      '',
      '> 费用按 Anthropic 公开标价估算，仅供参考；订阅套餐（Pro / Max）不按 token 计费。',
      '',
    );
  }

  // 二、项目
  push('## 二、项目', '');
  if (stats.projects.length === 0) {
    push('本周没有记录到项目活动。', '');
  } else {
    push(
      ...table(
        ['项目', '开发时长', '会话', '提交', '代码行', '文件', '完成任务'],
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
      push(`- 路径：${code(p.path)}`);
      if (p.gitRemote) push(`- 远程仓库：${p.gitRemote}`);
      push(
        `- 开发时长 ${formatDuration(p.activeSeconds)}，会话 ${p.sessions} 个，提交 ${p.commits} 次，修改文件 ${p.files} 个，执行命令 ${p.commands} 次（失败 ${p.commandFailures} 次）`,
      );
      const files = stats.files.top.filter((f) => f.projectId === p.id).slice(0, 5);
      if (files.length > 0) push(`- 主要修改：${files.map((f) => `${code(f.path)}（${f.edits}）`).join('、')}`);
      push('');
    }
  }

  // 三、完成任务
  push('## 三、完成任务', '');
  if (stats.tasks.completed.length > 0) {
    for (const task of stats.tasks.completed) {
      const when = task.completedAt ? weekdayLabel(new Date(task.completedAt)) : '';
      push(`- [x] ${task.title}（${task.projectName}${when ? `，${when}` : ''}）`);
    }
    if (stats.tasks.open > 0) push('', `另有 ${stats.tasks.open} 个本周创建的任务尚未完成。`);
    push('');
  } else if (stats.commits.length > 0) {
    push('本周没有记录到 Claude 任务清单（新版模型默认不启用任务工具），以下根据 Git 提交推断：', '');
    for (const c of [...stats.commits].reverse().slice(0, 30)) {
      push(`- [x] ${c.message}（${c.projectName}，${weekdayLabel(new Date(c.timestamp))}）`);
    }
    push('');
  } else {
    push('本周没有记录到已完成的任务。', '');
  }

  // 四、Git 活动
  push('## 四、Git 活动', '');
  if (stats.commits.length === 0) {
    push('本周没有 Git 提交。', '');
  } else {
    const withClaude = stats.commits.filter((c) => c.withClaude).length;
    push(
      `共 ${t.count} 次提交，涉及 ${formatNumber(t.filesChanged)} 个文件变更，+${formatNumber(t.insertions)} / -${formatNumber(t.deletions)} 行；其中 ${withClaude} 次提交发生在 Claude 会话期间。`,
      '',
    );
    push(
      ...table(
        ['时间', '项目', '分支', '提交', '说明', '变更'],
        [...stats.commits].reverse().map((c) => [
          formatDateTime(new Date(c.timestamp)),
          c.projectName,
          c.branch ?? '-',
          code(shortHash(c.hash)),
          c.message,
          `${c.filesChanged} 文件，+${c.insertions} / -${c.deletions}`,
        ]),
      ),
      '',
    );
  }

  // 五、文件修改
  push('## 五、文件修改', '');
  if (stats.files.distinct === 0) {
    push('本周没有记录到文件修改。', '');
  } else {
    push(
      `共修改 ${stats.files.distinct} 个文件（${stats.files.edits} 次修改），其中新增 ${stats.files.created} 个、删除 ${stats.files.deleted} 个。`,
      '',
    );
    push(
      ...table(
        ['项目', '文件', '修改次数'],
        stats.files.top.map((f) => [f.projectName, code(f.path), String(f.edits)]),
      ),
      '',
    );
  }

  // 六、技术问题
  push('## 六、技术问题', '');
  const issues: string[] = [];
  for (const cat of stats.commands.byCategory) {
    if (cat.failed > 0) {
      issues.push(`- ${categoryLabel(cat.category)}命令执行 ${cat.total} 次，失败 ${cat.failed} 次（失败率 ${percent(cat.failed, cat.total)}）`);
    }
  }
  const failures = stats.commands.failures.slice(0, 10);
  if (failures.length > 0) {
    issues.push('', '失败次数最多的命令：', '');
    for (const f of failures) {
      const exit = f.lastExitCode !== null ? `，最近退出码 ${f.lastExitCode}` : '';
      issues.push(`- ${code(f.command)}（${f.projectName}）失败 ${f.count} 次${exit}`);
    }
  }
  const toolFailures = stats.tools.filter((tool) => tool.failures > 0 && !SHELL_TOOLS.has(tool.tool));
  if (toolFailures.length > 0) {
    issues.push('', `工具调用失败：${toolFailures.map((tool) => `${tool.tool} ${tool.failures} 次`).join('，')}`);
  }
  if (issues.length === 0) push('本周未检测到失败的构建、测试命令或工具调用。', '');
  else push(...issues, '');

  // 七、AI 总结
  if (options.aiSummary) {
    push('## 七、AI 总结', '');
    push(options.aiSummary.text.trim(), '');
    push(`> 由 ${options.aiSummary.provider}（${options.aiSummary.model}）根据以上统计数据生成，仅发送了统计数字与任务摘要，未发送源代码。`, '');
  } else if (options.aiError) {
    push('## 七、AI 总结', '');
    push(`> AI 总结生成失败：${options.aiError}`, '');
  }

  push('---', '');
  push(
    `*由 DevTrack 自动生成，数据仅保存在本机。开发时长为活跃时长：同一会话内相邻活动间隔超过空闲阈值的时间不计入。*`,
    '',
  );
  return lines.join('\n');
}
