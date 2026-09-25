import { CATEGORY_LABELS, type CommandCategory } from '../core/commands.js';
import { formatCost, formatDuration, formatNumber, formatTokens, percent, shortHash } from '../core/format.js';
import { formatDate, formatDateTime, formatTime, weekdayLabel } from '../core/time.js';
import type { PeriodStats, SessionSummary } from '../stats/queries.js';
import { bar, c, heading, keyValues, table, truncate } from './format.js';

const STATUS_LABELS: Record<string, string> = {
  active: '进行中',
  ended: '已结束',
  abandoned: '已中断',
};

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category as CommandCategory] ?? category;
}

function commitsText(stats: PeriodStats): string {
  const t = stats.commitTotals;
  return `${t.count} 次${t.count > 0 ? c.gray(`（+${formatNumber(t.insertions)} / -${formatNumber(t.deletions)} 行）`) : ''}`;
}

/** 概况中的 "Token / 费用" 一行；没有用量记录时省略。 */
export function tokenRow(stats: PeriodStats): [string, string][] {
  const t = stats.tokens;
  if (!t) return [];
  const cost = t.cost === null ? c.gray('（价格未知）') : ` · 约 ${c.bold(formatCost(t.cost))}`;
  return [['Token / 费用', `${formatTokens(t.total)}${cost}`]];
}

export function renderTokens(stats: PeriodStats): string[] {
  const t = stats.tokens;
  if (!t) return [];
  const out = [heading('Token 用量（估算费用）')];
  out.push(
    table(
      ['模型', '请求', '输入', '输出', '缓存读取', '缓存写入', '费用'],
      t.byModel.map((m) => [
        m.model,
        formatNumber(m.messages),
        formatTokens(m.input),
        formatTokens(m.output),
        formatTokens(m.cacheRead),
        formatTokens(m.cacheWrite),
        m.cost === null ? c.gray('未知') : formatCost(m.cost),
      ]),
      { alignRight: [1, 2, 3, 4, 5, 6], maxWidths: [32] },
    ),
  );
  if (t.unpricedTokens > 0) {
    out.push(c.gray(`  ${formatTokens(t.unpricedTokens)} token 的模型价格未知，未计入费用；可通过配置 usage.prices 补充。`));
  }
  out.push(c.gray('  费用按 Anthropic 公开标价估算，仅供参考；订阅套餐（Pro / Max）不按 token 计费。'));
  return out;
}

function isEmpty(stats: PeriodStats): boolean {
  return (
    stats.sessions.length === 0 && stats.commits.length === 0 && stats.files.edits === 0 && stats.commands.total === 0
  );
}

const EMPTY_HINT = c.gray(
  '  这段时间没有记录到开发活动。\n  如果刚安装，请确认已运行 devtrack init 并重新启动 Claude Code；可运行 devtrack doctor 检查。',
);

function sessionTimeRange(s: SessionSummary): string {
  const start = new Date(s.startedAt);
  const end = new Date(s.endedAt ?? s.lastActivityAt);
  const sameDay = formatDate(start) === formatDate(end);
  return `${formatTime(start)}–${sameDay ? formatTime(end) : formatDateTime(end).slice(5)}`;
}

function renderSessions(stats: PeriodStats, limit: number): string[] {
  if (stats.sessions.length === 0) return [];
  const list = [...stats.sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  const out = [heading(`Claude 会话（${stats.sessions.length}）`)];
  out.push(
    table(
      ['时间', '项目', '活跃时长', '状态', '摘要 / 标题'],
      list.map((s) => [
        sessionTimeRange(s),
        s.projectName,
        formatDuration(s.activeSeconds, true),
        s.status === 'active' ? c.green(STATUS_LABELS[s.status]!) : (STATUS_LABELS[s.status] ?? s.status),
        s.summary ? truncate(s.summary, 60) : s.title ? c.gray(truncate(s.title, 40)) : c.gray('-'),
      ]),
      { maxWidths: [undefined, 24] },
    ),
  );
  if (stats.sessions.length > limit) out.push(c.gray(`  … 另有 ${stats.sessions.length - limit} 个会话`));
  return out;
}

function renderProjects(stats: PeriodStats, withShare: boolean): string[] {
  if (stats.projects.length === 0) return [];
  const max = Math.max(...stats.projects.map((p) => p.activeSeconds));
  const headers = withShare
    ? ['项目', '开发时长', '占比', '', '会话', '提交', '文件']
    : ['项目', '开发时长', '会话', '提交', '文件', '命令'];
  const rows = stats.projects.map((p) =>
    withShare
      ? [
          p.name,
          formatDuration(p.activeSeconds, true),
          percent(p.activeSeconds, stats.activeSeconds),
          bar(p.activeSeconds, max, 16),
          String(p.sessions),
          String(p.commits),
          String(p.files),
        ]
      : [
          p.name,
          formatDuration(p.activeSeconds, true),
          String(p.sessions),
          String(p.commits),
          String(p.files),
          String(p.commands),
        ],
  );
  return [
    heading(withShare ? '各项目开发时间' : '项目'),
    table(headers, rows, { alignRight: withShare ? [1, 2, 4, 5, 6] : [1, 2, 3, 4, 5], maxWidths: [28] }),
  ];
}

function renderFiles(stats: PeriodStats, limit: number): string[] {
  if (stats.files.top.length === 0) return [];
  return [
    heading(`修改文件 Top ${Math.min(limit, stats.files.top.length)}`),
    table(
      ['项目', '文件', '次数'],
      stats.files.top.slice(0, limit).map((f) => [f.projectName, f.path, String(f.edits)]),
      { maxWidths: [20, 60], alignRight: [2] },
    ),
  ];
}

function renderCommits(stats: PeriodStats, limit: number, withDate: boolean): string[] {
  if (stats.commits.length === 0) return [];
  const out = [heading(`Git 提交（${stats.commits.length}）`)];
  out.push(
    table(
      ['时间', '项目', '提交', '说明', '变更'],
      stats.commits.slice(0, limit).map((cm) => [
        withDate ? formatDateTime(new Date(cm.timestamp)).slice(5) : formatTime(new Date(cm.timestamp)),
        cm.projectName,
        c.yellow(shortHash(cm.hash)),
        truncate(cm.message, 50),
        c.gray(`+${cm.insertions}/-${cm.deletions}`),
      ]),
      { maxWidths: [undefined, 20] },
    ),
  );
  if (stats.commits.length > limit) out.push(c.gray(`  … 另有 ${stats.commits.length - limit} 次提交`));
  return out;
}

function renderTasks(stats: PeriodStats, limit: number): string[] {
  if (stats.tasks.completed.length === 0) return [];
  const out = [heading(`完成任务（${stats.tasks.completed.length}）`)];
  for (const t of stats.tasks.completed.slice(-limit)) {
    out.push(`  ${c.green('✔')} ${t.title} ${c.gray(`(${t.projectName})`)}`);
  }
  if (stats.tasks.completed.length > limit) out.push(c.gray(`  … 另有 ${stats.tasks.completed.length - limit} 个任务`));
  return out;
}

function renderCommandSummary(stats: PeriodStats): string[] {
  if (stats.commands.total === 0) return [];
  const parts = stats.commands.byCategory.map(
    (cat) => `${categoryLabel(cat.category)} ${cat.total}${cat.failed > 0 ? c.red(`（失败 ${cat.failed}）`) : ''}`,
  );
  return [heading('命令'), `  ${parts.join(c.gray(' · '))}`];
}

export function renderToday(stats: PeriodStats, title = '今天'): string {
  const out: string[] = [c.bold(`${title} · ${stats.range.label}`)];
  if (isEmpty(stats)) return [...out, '', EMPTY_HINT, ''].join('\n');
  out.push(
    '',
    keyValues([
      ['开发时长', c.bold(formatDuration(stats.activeSeconds))],
      [
        'Claude 会话',
        `${stats.sessions.length} 个${stats.runningSessions > 0 ? c.gray(`（进行中 ${stats.runningSessions}）`) : ''}`,
      ],
      ['项目', `${stats.projects.length} 个`],
      ['修改文件', `${stats.files.distinct} 个${c.gray(`（${stats.files.edits} 次修改）`)}`],
      ['Git 提交', commitsText(stats)],
      ['完成任务', `${stats.tasks.completed.length} 个`],
      ['执行命令', `${stats.commands.total} 次${stats.commands.failed > 0 ? c.red(`（失败 ${stats.commands.failed}）`) : ''}`],
      ...tokenRow(stats),
    ]),
  );
  out.push(...renderProjects(stats, false));
  out.push(...renderSessions(stats, 10));
  out.push(...renderCommits(stats, 10, false));
  out.push(...renderFiles(stats, 10));
  out.push(...renderTasks(stats, 20));
  out.push(...renderCommandSummary(stats));
  out.push(...renderTokens(stats));
  return out.join('\n') + '\n';
}

function renderDaily(stats: PeriodStats, onlyActive: boolean): string[] {
  const days = onlyActive
    ? stats.daily.filter((d) => d.activeSeconds > 0 || d.commits > 0 || d.fileEdits > 0)
    : stats.daily;
  if (days.length === 0) return [];
  const max = Math.max(...days.map((d) => d.activeSeconds));
  return [
    heading('每日'),
    table(
      ['日期', '', '开发时长', '会话', '提交', '文件'],
      days.map((d) => {
        const date = new Date(`${d.date}T00:00:00`);
        return [
          `${weekdayLabel(date)} ${d.date.slice(5)}`,
          bar(d.activeSeconds, max, 20) || c.gray('·'),
          d.activeSeconds > 0 ? formatDuration(d.activeSeconds, true) : c.gray('-'),
          String(d.sessions),
          String(d.commits),
          String(d.fileEdits),
        ];
      }),
      { alignRight: [2, 3, 4, 5] },
    ),
  ];
}

export function renderPeriodSummary(
  stats: PeriodStats,
  title: string,
  onlyActiveDays: boolean,
  options: { singleProject?: boolean } = {},
): string {
  const start = new Date(stats.range.start);
  const lastDay = new Date(new Date(stats.range.end).getTime() - 1);
  const out: string[] = [
    c.bold(`${title} · ${stats.range.label}`) + c.gray(`（${formatDate(start)} ~ ${formatDate(lastDay)}）`),
  ];
  if (isEmpty(stats)) return [...out, '', EMPTY_HINT, ''].join('\n');
  out.push(
    '',
    keyValues([
      ['开发时长', c.bold(formatDuration(stats.activeSeconds))],
      ['活跃天数', `${stats.activeDays} 天`],
      ['Claude 会话', `${stats.sessions.length} 个`],
      ...(options.singleProject ? [] : [['项目数量', `${stats.projects.length} 个`] as [string, string]]),
      ['Commit 数', commitsText(stats)],
      ['文件修改', `${stats.files.distinct} 个${c.gray(`（${stats.files.edits} 次修改）`)}`],
      ['完成任务', `${stats.tasks.completed.length} 个`],
      ['执行命令', `${stats.commands.total} 次${stats.commands.failed > 0 ? c.red(`（失败 ${stats.commands.failed}）`) : ''}`],
      ...tokenRow(stats),
    ]),
  );
  out.push(...renderDaily(stats, onlyActiveDays));
  if (!options.singleProject) out.push(...renderProjects(stats, true));
  out.push(...renderTasks(stats, 15));
  out.push(...renderCommits(stats, 8, true));
  out.push(...renderFiles(stats, 8));
  out.push(...renderCommandSummary(stats));
  out.push(...renderTokens(stats));
  return out.join('\n') + '\n';
}
