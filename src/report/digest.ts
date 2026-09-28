import { formatCost, formatDuration, formatNumber, formatTokens } from '../core/format.js';
import { formatDate } from '../core/time.js';
import { L } from '../i18n.js';
import type { PeriodStats } from '../stats/queries.js';
import type { NotifyMessage } from '../notify/webhook.js';
import type { ReportPeriod } from './weekly.js';

/**
 * 周报 / 月报的精简版，用于推送到聊天工具：概况、主要项目、工单、完成任务与 AI 总结。
 * 不包含文件路径与命令原文。
 */
export function buildReportDigest(
  stats: PeriodStats,
  options: { period: ReportPeriod; aiSummary?: { text: string } },
): NotifyMessage {
  const start = new Date(stats.range.start);
  const lastDay = new Date(new Date(stats.range.end).getTime() - 1);
  const kind = options.period === 'week' ? L('周报', 'Weekly Report') : L('月报', 'Monthly Report');
  const title = L(
    `DevTrack ${kind} · ${stats.range.label}（${formatDate(start).slice(5)} ~ ${formatDate(lastDay).slice(5)}）`,
    `DevTrack ${kind} · ${stats.range.label} (${formatDate(start).slice(5)} ~ ${formatDate(lastDay).slice(5)})`,
  );
  const t = stats.commitTotals;
  const lines: string[] = [];
  lines.push(
    L(
      `开发时长 ${formatDuration(stats.activeSeconds)} · 活跃 ${stats.activeDays} 天 · 会话 ${stats.sessions.length} 个 · 提交 ${t.count} 次（+${formatNumber(t.insertions)} / -${formatNumber(t.deletions)} 行）`,
      `Active ${formatDuration(stats.activeSeconds)} · ${stats.activeDays} active days · ${stats.sessions.length} sessions · ${t.count} commits (+${formatNumber(t.insertions)} / -${formatNumber(t.deletions)} lines)`,
    ),
  );
  if (stats.tokens) {
    lines.push(`${L('Token / 估算费用', 'Tokens / estimated cost')}${L('：', ': ')}${formatTokens(stats.tokens.total)} / ${formatCost(stats.tokens.cost)}`);
  }
  if (stats.projects.length > 0) {
    lines.push('', L('项目', 'Projects'));
    for (const p of stats.projects.slice(0, 8)) {
      lines.push(
        L(
          `  • ${p.name}：${formatDuration(p.activeSeconds)}，提交 ${p.commits} 次，修改文件 ${p.files} 个`,
          `  • ${p.name}: ${formatDuration(p.activeSeconds)}, ${p.commits} commits, ${p.files} files`,
        ),
      );
    }
  }
  if (stats.tickets.length > 0) {
    lines.push('', L('工单', 'Tickets'));
    for (const tk of stats.tickets.slice(0, 10)) {
      const time = tk.activeSeconds > 0 ? formatDuration(tk.activeSeconds) : '-';
      lines.push(L(`  • ${tk.id}：${time}，提交 ${tk.commits} 次`, `  • ${tk.id}: ${time}, ${tk.commits} commits`));
    }
  }
  if (stats.tasks.completed.length > 0) {
    lines.push('', L(`完成任务（${stats.tasks.completed.length}）`, `Completed tasks (${stats.tasks.completed.length})`));
    for (const task of stats.tasks.completed.slice(0, 10)) lines.push(`  • ${task.title}`);
  }
  if (options.aiSummary) lines.push('', L('AI 总结', 'AI summary'), options.aiSummary.text.trim());
  return {
    kind: 'report',
    title,
    text: lines.join('\n'),
    data: {
      period: options.period,
      label: stats.range.label,
      range: stats.range,
      activeSeconds: stats.activeSeconds,
      activeDays: stats.activeDays,
      sessions: stats.sessions.length,
      commits: t.count,
      projects: stats.projects.map((p) => ({ name: p.name, activeSeconds: p.activeSeconds, commits: p.commits })),
      tickets: stats.tickets.map((tk) => ({ id: tk.id, activeSeconds: tk.activeSeconds, commits: tk.commits })),
    },
  };
}
