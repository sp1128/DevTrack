import type { DevTrackConfig } from '../config.js';
import { categoryLabel } from '../core/commands.js';
import { formatDuration, toHours } from '../core/format.js';
import { formatDate, todayRange, weekdayLabel, type DateRange } from '../core/time.js';
import type { DB } from '../db/database.js';
import { getLang, L } from '../i18n.js';
import { collectPeriodStats, type PeriodStats, type StatsOptions } from '../stats/queries.js';
import { completeText, type AiDeps, type AiResult } from './ai.js';
import { resolveSummaryModel } from './sessionSummary.js';

/**
 * 站会摘要：上一个有活动的工作日做了什么、今天到目前为止做了什么、遇到了哪些问题。
 * 内容来自提交说明、会话摘要、完成的任务与失败的命令，不包含源代码和对话内容。
 */

export interface StandupDay {
  date: string;
  range: DateRange;
  stats: PeriodStats;
}

export interface StandupData {
  /** 今天之前最近一个有活动的日子；没有更早的记录时为 null */
  previous: StandupDay | null;
  today: StandupDay;
}

/** 某个时间点之前最近一次活动（事件或提交）的时间。 */
function lastActivityBefore(db: DB, before: Date): Date | null {
  const iso = before.toISOString();
  const row = db
    .prepare(
      `SELECT MAX(t) AS t FROM (
         SELECT MAX(timestamp) AS t FROM events WHERE timestamp < ?
         UNION ALL SELECT MAX(timestamp) FROM git_commits WHERE timestamp < ?
       )`,
    )
    .get(iso, iso) as { t: string | null };
  return row.t ? new Date(row.t) : null;
}

export function collectStandup(db: DB, now: Date, options: StatsOptions): StandupData {
  const todayR = todayRange(now);
  const today = { date: formatDate(todayR.start), range: todayR, stats: collectPeriodStats(db, todayR, options) };
  const last = lastActivityBefore(db, todayR.start);
  if (!last) return { previous: null, today };
  const prevR = todayRange(last);
  return { previous: { date: formatDate(prevR.start), range: prevR, stats: collectPeriodStats(db, prevR, options) }, today };
}

export interface StandupProject {
  name: string;
  activeSeconds: number;
  tickets: string[];
  /** 做了什么：提交说明、会话摘要、完成的任务（去重，按时间先后） */
  items: string[];
  /** 没有提交、摘要和任务时的概括 */
  fallback: string | null;
}

/** 把一天的统计整理成按项目的条目。 */
export function standupProjects(stats: PeriodStats, maxItems = 6): StandupProject[] {
  return stats.projects
    .filter((p) => p.activeSeconds > 0 || p.commits > 0 || p.fileEdits > 0 || p.tasksCompleted > 0)
    .map((p) => {
      const items: string[] = [];
      const add = (text: string | null | undefined) => {
        const t = text?.trim();
        if (t && !items.includes(t)) items.push(t);
      };
      for (const c of [...stats.commits].reverse()) if (c.projectId === p.id) add(c.message);
      for (const s of stats.sessions) if (s.projectId === p.id) add(s.summary);
      for (const t of stats.tasks.completed) if (t.projectName === p.name) add(t.title);
      const fallback =
        items.length > 0
          ? null
          : L(
              `修改 ${p.files} 个文件，执行命令 ${p.commands} 次`,
              `modified ${p.files} files, ran ${p.commands} commands`,
            );
      return {
        name: p.name,
        activeSeconds: p.activeSeconds,
        tickets: stats.tickets.filter((t) => t.projects.includes(p.name)).map((t) => t.id),
        items: items.slice(0, maxItems),
        fallback,
      };
    });
}

/** 两天里失败的命令（按类别和命令汇总，最多 5 条）。 */
export function standupProblems(data: StandupData): string[] {
  const days = [data.previous, data.today].filter((d): d is StandupDay => d !== null);
  const map = new Map<string, { text: string; count: number }>();
  for (const day of days) {
    for (const f of day.stats.commands.failures) {
      const key = `${f.projectName}\u0000${f.command}`;
      const cur = map.get(key);
      if (cur) cur.count += f.count;
      else {
        const cat = categoryLabel(f.category);
        map.set(key, {
          text: L(`${cat}：${f.command}（${f.projectName}）`, `${cat}: ${f.command} (${f.projectName})`),
          count: f.count,
        });
      }
    }
  }
  return [...map.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((p) => L(`${p.text} 失败 ${p.count} 次`, `${p.text} failed ${p.count === 1 ? 'once' : `${p.count} times`}`));
}

/** 标题：目标日为"今天"（或指定日期时为"当天"）；上一个活动日紧挨着目标日时为"昨天"，否则为"上次"。 */
function dayTitle(day: StandupDay, target: StandupDay, now: Date): string {
  const label = `${weekdayLabel(new Date(`${day.date}T00:00:00`))} ${day.date.slice(5)}`;
  if (day === target) {
    return day.date === formatDate(todayRange(now).start) ? L(`今天（${label}）`, `Today (${label})`) : L(`当天（${label}）`, `Day (${label})`);
  }
  const dayBefore = formatDate(todayRange(target.range.start, -1).start);
  return day.date === dayBefore ? L(`昨天（${label}）`, `Yesterday (${label})`) : L(`上次（${label}）`, `Last active (${label})`);
}

function renderDay(day: StandupDay | null, target: StandupDay, now: Date): string[] {
  if (!day) return [];
  const out = [`${dayTitle(day, target, now)}${day.stats.activeSeconds > 0 ? ` · ${formatDuration(day.stats.activeSeconds)}` : ''}`];
  const projects = standupProjects(day.stats);
  if (projects.length === 0) {
    out.push(L('  - 暂无记录', '  - nothing recorded yet'));
    return out;
  }
  for (const p of projects) {
    const tickets = p.tickets.length > 0 ? ` [${p.tickets.join(', ')}]` : '';
    const time = p.activeSeconds > 0 ? L(`（${formatDuration(p.activeSeconds)}）`, ` (${formatDuration(p.activeSeconds)})`) : '';
    out.push(`  • ${p.name}${tickets}${time}`);
    for (const item of p.items) out.push(`    - ${item}`);
    if (p.fallback) out.push(`    - ${p.fallback}`);
  }
  return out;
}

/** 纯文本站会摘要，可以直接粘贴到聊天工具。 */
export function renderStandup(data: StandupData, now: Date): string {
  const target = new Date(`${data.today.date}T00:00:00`);
  const out = [L(`站会 · ${data.today.date}（${weekdayLabel(target)}）`, `Standup · ${data.today.date} (${weekdayLabel(target)})`), ''];
  if (data.previous) out.push(...renderDay(data.previous, data.today, now), '');
  out.push(...renderDay(data.today, data.today, now), '');
  const problems = standupProblems(data);
  out.push(L('问题', 'Blockers'));
  if (problems.length === 0) out.push(L('  - 无', '  - none'));
  else for (const p of problems) out.push(`  - ${p}`);
  return out.join('\n') + '\n';
}

/** 发送给 AI 的数据（模型与会话摘要相同：Anthropic 默认 claude-haiku-4-5，可用 ai.sessionSummaryModel 指定）：只有项目名、工单号、提交说明、会话摘要、任务标题与失败命令的统计。 */
export function buildStandupPayload(data: StandupData): Record<string, unknown> {
  const day = (d: StandupDay) => ({
    date: d.date,
    activeHours: toHours(d.stats.activeSeconds),
    projects: standupProjects(d.stats, 10).map((p) => ({
      name: p.name,
      activeHours: toHours(p.activeSeconds),
      tickets: p.tickets,
      work: p.items,
      ...(p.fallback ? { note: p.fallback } : {}),
    })),
  });
  return {
    previous: data.previous ? day(data.previous) : null,
    today: day(data.today),
    problems: standupProblems(data),
  };
}

function systemPrompt(): string {
  if (getLang() === 'en') {
    return [
      'You write daily standup updates for a software engineer from statistics collected automatically by the local tool DevTrack (JSON; no conversation content).',
      'Write three short Markdown sections: **Yesterday**, **Today**, **Blockers**. Use bullet points, grouped by project or ticket when helpful.',
      'Use only the given data, do not invent work. Keep it under 120 words. Output the update directly.',
    ].join('\n');
  }
  return [
    '你为软件工程师撰写每日站会发言。数据由本地工具 DevTrack 自动采集（JSON，不含对话内容）。',
    '用简体中文写三个简短的 Markdown 小节：**昨天**、**今天**、**问题**，使用列表，必要时按项目或工单分组。',
    '只依据给定数据，不要编造工作内容；总长度不超过 200 字；直接输出正文。',
  ].join('\n');
}

export async function generateAiStandup(data: StandupData, config: DevTrackConfig, deps: AiDeps = {}): Promise<AiResult> {
  const user = `${L('站会数据：', 'Standup data:')}\n\n\`\`\`json\n${JSON.stringify(buildStandupPayload(data), null, 2)}\n\`\`\``;
  return completeText(config, resolveSummaryModel(config), { system: systemPrompt(), user, maxTokens: 4096 }, deps);
}
