import { categoryLabel } from '../core/commands.js';
import { formatCost, formatDuration, formatNumber, formatTokens, percent, shortHash } from '../core/format.js';
import { formatDate, formatDateTime, formatTime, weekdayLabel } from '../core/time.js';
import { L } from '../i18n.js';
import type { PeriodStats, SessionSummary } from '../stats/queries.js';
import { bar, c, heading, keyValues, table, truncate } from './format.js';

function statusLabel(status: string): string {
  switch (status) {
    case 'active':
      return L('进行中', 'Active');
    case 'ended':
      return L('已结束', 'Ended');
    case 'abandoned':
      return L('已中断', 'Abandoned');
    default:
      return status;
  }
}

/** "3 个" / "3" 这类计数 */
const count = (n: number, zhUnit: string) => L(`${n} ${zhUnit}`, String(n));

function commitsText(stats: PeriodStats): string {
  const t = stats.commitTotals;
  const lines = L(
    `（+${formatNumber(t.insertions)} / -${formatNumber(t.deletions)} 行）`,
    ` (+${formatNumber(t.insertions)} / -${formatNumber(t.deletions)} lines)`,
  );
  return `${count(t.count, '次')}${t.count > 0 ? c.gray(lines) : ''}`;
}

function filesText(stats: PeriodStats): string {
  return `${count(stats.files.distinct, '个')}${c.gray(L(`（${stats.files.edits} 次修改）`, ` (${stats.files.edits} edits)`))}`;
}

function commandsText(stats: PeriodStats): string {
  const failed = stats.commands.failed;
  return `${count(stats.commands.total, '次')}${failed > 0 ? c.red(L(`（失败 ${failed}）`, ` (${failed} failed)`)) : ''}`;
}

/** 概况中的 "Token / 费用" 一行；没有用量记录时省略。 */
export function tokenRow(stats: PeriodStats): [string, string][] {
  const t = stats.tokens;
  if (!t) return [];
  const cost =
    t.cost === null
      ? c.gray(L('（价格未知）', ' (price unknown)'))
      : ` · ${L('约', '~')} ${c.bold(formatCost(t.cost))}`;
  return [[L('Token / 费用', 'Tokens / cost'), `${formatTokens(t.total)}${cost}`]];
}

export function renderTokens(stats: PeriodStats): string[] {
  const t = stats.tokens;
  if (!t) return [];
  const out = [heading(L('Token 用量（估算费用）', 'Token usage (estimated cost)'))];
  out.push(
    table(
      L('模型|请求|输入|输出|缓存读取|缓存写入|费用', 'Model|Requests|Input|Output|Cache read|Cache write|Cost').split('|'),
      t.byModel.map((m) => [
        m.model,
        formatNumber(m.messages),
        formatTokens(m.input),
        formatTokens(m.output),
        formatTokens(m.cacheRead),
        formatTokens(m.cacheWrite),
        m.cost === null ? c.gray(L('未知', 'unknown')) : formatCost(m.cost),
      ]),
      { alignRight: [1, 2, 3, 4, 5, 6], maxWidths: [32] },
    ),
  );
  if (t.unpricedTokens > 0) {
    out.push(
      c.gray(
        L(
          `  ${formatTokens(t.unpricedTokens)} token 的模型价格未知，未计入费用；可通过配置 usage.prices 补充。`,
          `  ${formatTokens(t.unpricedTokens)} tokens are from models with unknown prices and are not included; add prices via usage.prices.`,
        ),
      ),
    );
  }
  out.push(
    c.gray(
      L(
        '  费用按 Anthropic 公开标价估算，仅供参考；订阅套餐（Pro / Max）不按 token 计费。',
        '  Estimated from Anthropic list prices, for reference only; subscription plans (Pro / Max) are not billed per token.',
      ),
    ),
  );
  return out;
}

function isEmpty(stats: PeriodStats): boolean {
  return (
    stats.sessions.length === 0 && stats.commits.length === 0 && stats.files.edits === 0 && stats.commands.total === 0
  );
}

function emptyHint(): string {
  return c.gray(
    L(
      '  这段时间没有记录到开发活动。\n  如果刚安装，请确认已运行 devtrack init 并重新启动 Claude Code；可运行 devtrack doctor 检查。',
      '  No development activity recorded in this period.\n  If you just installed DevTrack, make sure you ran devtrack init and restarted Claude Code; run devtrack doctor to check.',
    ),
  );
}

function sessionTimeRange(s: SessionSummary): string {
  const start = new Date(s.startedAt);
  const end = new Date(s.endedAt ?? s.lastActivityAt);
  const sameDay = formatDate(start) === formatDate(end);
  return `${formatTime(start)}–${sameDay ? formatTime(end) : formatDateTime(end).slice(5)}`;
}

function renderSessions(stats: PeriodStats, limit: number): string[] {
  if (stats.sessions.length === 0) return [];
  const list = [...stats.sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  const out = [heading(L(`Claude 会话（${stats.sessions.length}）`, `Claude sessions (${stats.sessions.length})`))];
  out.push(
    table(
      L('时间|项目|活跃时长|状态|摘要 / 标题', 'Time|Project|Active|Status|Summary / title').split('|'),
      list.map((s) => [
        sessionTimeRange(s),
        s.projectName,
        formatDuration(s.activeSeconds, true),
        s.status === 'active' ? c.green(statusLabel(s.status)) : statusLabel(s.status),
        s.summary ? truncate(s.summary, 60) : s.title ? c.gray(truncate(s.title, 40)) : c.gray('-'),
      ]),
      { maxWidths: [undefined, 24] },
    ),
  );
  const more = stats.sessions.length - limit;
  if (more > 0) out.push(c.gray(L(`  … 另有 ${more} 个会话`, `  … and ${more} more sessions`)));
  return out;
}

function renderProjects(stats: PeriodStats, withShare: boolean): string[] {
  if (stats.projects.length === 0) return [];
  const max = Math.max(...stats.projects.map((p) => p.activeSeconds));
  const headers = withShare
    ? L('项目|开发时长|占比||会话|提交|文件', 'Project|Active|Share||Sessions|Commits|Files').split('|')
    : L('项目|开发时长|会话|提交|文件|命令', 'Project|Active|Sessions|Commits|Files|Commands').split('|');
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
    heading(withShare ? L('各项目开发时间', 'Time by project') : L('项目', 'Projects')),
    table(headers, rows, { alignRight: withShare ? [1, 2, 4, 5, 6] : [1, 2, 3, 4, 5], maxWidths: [28] }),
  ];
}

function renderFiles(stats: PeriodStats, limit: number): string[] {
  if (stats.files.top.length === 0) return [];
  const n = Math.min(limit, stats.files.top.length);
  return [
    heading(L(`修改文件 Top ${n}`, `Top ${n} modified files`)),
    table(
      L('项目|文件|次数', 'Project|File|Edits').split('|'),
      stats.files.top.slice(0, limit).map((f) => [f.projectName, f.path, String(f.edits)]),
      { maxWidths: [20, 60], alignRight: [2] },
    ),
  ];
}

function renderCommits(stats: PeriodStats, limit: number, withDate: boolean): string[] {
  if (stats.commits.length === 0) return [];
  const out = [heading(L(`Git 提交（${stats.commits.length}）`, `Git commits (${stats.commits.length})`))];
  out.push(
    table(
      L('时间|项目|提交|说明|变更', 'Time|Project|Commit|Message|Changes').split('|'),
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
  const more = stats.commits.length - limit;
  if (more > 0) out.push(c.gray(L(`  … 另有 ${more} 次提交`, `  … and ${more} more commits`)));
  return out;
}

function renderTasks(stats: PeriodStats, limit: number): string[] {
  if (stats.tasks.completed.length === 0) return [];
  const out = [heading(L(`完成任务（${stats.tasks.completed.length}）`, `Completed tasks (${stats.tasks.completed.length})`))];
  for (const t of stats.tasks.completed.slice(-limit)) {
    out.push(`  ${c.green('✔')} ${t.title} ${c.gray(`(${t.projectName})`)}`);
  }
  const more = stats.tasks.completed.length - limit;
  if (more > 0) out.push(c.gray(L(`  … 另有 ${more} 个任务`, `  … and ${more} more tasks`)));
  return out;
}

function renderCommandSummary(stats: PeriodStats): string[] {
  if (stats.commands.total === 0) return [];
  const parts = stats.commands.byCategory.map(
    (cat) =>
      `${categoryLabel(cat.category)} ${cat.total}${cat.failed > 0 ? c.red(L(`（失败 ${cat.failed}）`, ` (${cat.failed} failed)`)) : ''}`,
  );
  return [heading(L('命令', 'Commands')), `  ${parts.join(c.gray(' · '))}`];
}

export function renderToday(stats: PeriodStats, title = L('今天', 'Today')): string {
  const out: string[] = [c.bold(`${title} · ${stats.range.label}`)];
  if (isEmpty(stats)) return [...out, '', emptyHint(), ''].join('\n');
  const running = stats.runningSessions;
  out.push(
    '',
    keyValues([
      [L('开发时长', 'Active time'), c.bold(formatDuration(stats.activeSeconds))],
      [
        L('Claude 会话', 'Claude sessions'),
        `${count(stats.sessions.length, '个')}${running > 0 ? c.gray(L(`（进行中 ${running}）`, ` (${running} active)`)) : ''}`,
      ],
      [L('项目', 'Projects'), count(stats.projects.length, '个')],
      [L('修改文件', 'Files modified'), filesText(stats)],
      [L('Git 提交', 'Git commits'), commitsText(stats)],
      [L('完成任务', 'Tasks completed'), count(stats.tasks.completed.length, '个')],
      [L('执行命令', 'Commands run'), commandsText(stats)],
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
    heading(L('每日', 'Daily')),
    table(
      L('日期||开发时长|会话|提交|文件', 'Date||Active|Sessions|Commits|Files').split('|'),
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
    c.bold(`${title} · ${stats.range.label}`) +
      c.gray(L(`（${formatDate(start)} ~ ${formatDate(lastDay)}）`, ` (${formatDate(start)} ~ ${formatDate(lastDay)})`)),
  ];
  if (isEmpty(stats)) return [...out, '', emptyHint(), ''].join('\n');
  out.push(
    '',
    keyValues([
      [L('开发时长', 'Active time'), c.bold(formatDuration(stats.activeSeconds))],
      [L('活跃天数', 'Active days'), count(stats.activeDays, '天')],
      [L('Claude 会话', 'Claude sessions'), count(stats.sessions.length, '个')],
      ...(options.singleProject ? [] : [[L('项目数量', 'Projects'), count(stats.projects.length, '个')] as [string, string]]),
      [L('Commit 数', 'Commits'), commitsText(stats)],
      [L('文件修改', 'Files modified'), filesText(stats)],
      [L('完成任务', 'Tasks completed'), count(stats.tasks.completed.length, '个')],
      [L('执行命令', 'Commands run'), commandsText(stats)],
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
