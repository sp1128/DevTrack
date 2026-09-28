import { toHours } from '../core/format.js';
import { formatDate, monthRange, parseDay, startOfDayLocal, todayRange, weekRange, type DateRange } from '../core/time.js';
import { listProjects } from '../db/repo.js';
import { collectStandup, buildStandupPayload, renderStandup } from '../report/standup.js';
import { collectPeriodStats, earliestRecord, type PeriodStats } from '../stats/queries.js';
import { openCli, statsOptions, type CliContext } from '../cli/context.js';
import type { McpTool } from './server.js';

/**
 * DevTrack MCP 工具：只读查询本地数据库，让 Claude Code 能回答
 * "我这周在哪个项目上花了多少时间""昨天做了什么""AUTH-42 花了多久""这个月 token 花了多少钱"。
 */

export const PERIODS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'all'] as const;
type Period = (typeof PERIODS)[number];

const periodSchema = {
  type: 'string',
  enum: [...PERIODS],
  description: 'Time range. Weeks start on Monday (local time). Default: this_week.',
};
const dateSchema = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'A single local date (YYYY-MM-DD); overrides period.' };
const projectSchema = { type: 'string', description: 'Project name (case-insensitive) or absolute path. Omit for all projects.' };

/** 打开数据库执行查询。openCli 会先结束长时间无活动的会话并同步 Git 提交（有节流）。 */
function withData<T>(fn: (ctx: CliContext) => T): T {
  const ctx = openCli({ sync: true });
  try {
    return fn(ctx);
  } finally {
    ctx.close();
  }
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new Error(`${key} must be a string`);
  return v;
}

function resolveRange(ctx: CliContext, args: Record<string, unknown>): DateRange {
  const date = str(args, 'date');
  if (date) {
    const r = parseDay(date);
    if (!r) throw new Error(`Invalid date: ${date} (expected YYYY-MM-DD)`);
    return r;
  }
  const period = (str(args, 'period') ?? 'this_week') as Period;
  const now = ctx.now;
  switch (period) {
    case 'today':
      return todayRange(now);
    case 'yesterday':
      return todayRange(now, -1);
    case 'this_week':
      return weekRange(now);
    case 'last_week':
      return weekRange(now, -1);
    case 'this_month':
      return monthRange(now);
    case 'last_month':
      return monthRange(now, -1);
    case 'all': {
      const first = earliestRecord(ctx.db) ?? now;
      return { start: startOfDayLocal(first), end: new Date(now.getTime() + 60_000), label: 'all records' };
    }
    default:
      throw new Error(`Invalid period: ${period} (expected one of ${PERIODS.join(', ')})`);
  }
}

function resolveProject(ctx: CliContext, args: Record<string, unknown>): { id: number; name: string } | undefined {
  const query = str(args, 'project');
  if (!query) return undefined;
  const projects = listProjects(ctx.db);
  const lower = query.toLowerCase();
  const hit =
    projects.find((p) => p.path === query) ??
    projects.find((p) => p.name.toLowerCase() === lower) ??
    (() => {
      const fuzzy = projects.filter((p) => p.name.toLowerCase().includes(lower));
      return fuzzy.length === 1 ? fuzzy[0] : undefined;
    })();
  if (!hit) {
    throw new Error(`Project not found: ${query}. Known projects: ${projects.map((p) => p.name).join(', ') || '(none)'}`);
  }
  return { id: hit.id, name: hit.name };
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 1);
}

/** 统计结果的精简版本，控制输出大小。 */
export function summarizeStats(stats: PeriodStats): Record<string, unknown> {
  const multiDay = stats.daily.length > 1;
  return {
    period: stats.range.label,
    range: { start: stats.range.start, end: stats.range.end },
    activeHours: toHours(stats.activeSeconds),
    activeDays: stats.activeDays,
    sessions: stats.sessions.length,
    runningSessions: stats.runningSessions,
    prompts: stats.prompts,
    projects: stats.projects.slice(0, 20).map((p) => ({
      name: p.name,
      activeHours: toHours(p.activeSeconds),
      sessions: p.sessions,
      commits: p.commits,
      insertions: p.insertions,
      deletions: p.deletions,
      filesModified: p.files,
      commandFailures: p.commandFailures,
      tasksCompleted: p.tasksCompleted,
      ...(p.tokens > 0 ? { tokens: p.tokens, estimatedCostUSD: p.cost === null ? null : Math.round(p.cost * 100) / 100 } : {}),
    })),
    tickets: stats.tickets.slice(0, 20).map((t) => ({
      id: t.id,
      projects: t.projects,
      activeHours: toHours(t.activeSeconds),
      sessions: t.sessions,
      commits: t.commits,
      commitMessages: t.commitMessages,
    })),
    commits: {
      count: stats.commitTotals.count,
      insertions: stats.commitTotals.insertions,
      deletions: stats.commitTotals.deletions,
      recent: stats.commits.slice(0, 30).map((c) => ({
        project: c.projectName,
        time: c.timestamp,
        branch: c.branch,
        message: c.message,
        duringClaudeSession: c.withClaude,
      })),
    },
    files: {
      modified: stats.files.distinct,
      edits: stats.files.edits,
      created: stats.files.created,
      top: stats.files.top.slice(0, 10).map((f) => ({ project: f.projectName, path: f.path, edits: f.edits })),
    },
    commands: {
      total: stats.commands.total,
      failed: stats.commands.failed,
      byCategory: stats.commands.byCategory,
      topFailures: stats.commands.failures.slice(0, 5).map((f) => ({
        project: f.projectName,
        command: f.command,
        category: f.category,
        count: f.count,
        lastExitCode: f.lastExitCode,
      })),
    },
    tasksCompleted: stats.tasks.completed.slice(0, 30).map((t) => ({ project: t.projectName, title: t.title })),
    sessionSummaries: stats.sessions
      .filter((s) => s.summary || s.title)
      .slice(-20)
      .map((s) => ({ project: s.projectName, started: s.startedAt, summary: s.summary ?? s.title })),
    ...(stats.tokens
      ? {
          tokens: {
            total: stats.tokens.total,
            estimatedCostUSD: stats.tokens.cost === null ? null : Math.round(stats.tokens.cost * 100) / 100,
          },
        }
      : {}),
    ...(multiDay
      ? {
          daily: stats.daily.map((d) => ({ date: d.date, activeHours: toHours(d.activeSeconds), sessions: d.sessions, commits: d.commits })),
        }
      : {}),
  };
}

export const TOOLS: McpTool[] = [
  {
    name: 'get_activity_summary',
    title: 'Development activity summary',
    description:
      "Summarize the user's recorded development activity from DevTrack: active time (idle gaps excluded), Claude Code sessions, projects, tickets (from branch names / commit messages), Git commits, modified files, failed commands, completed tasks and token cost. Use it to answer questions like 'what did I work on this week', 'how long did I spend on project X' or 'how much time went into AUTH-42'.",
    inputSchema: {
      type: 'object',
      properties: { period: periodSchema, date: dateSchema, project: projectSchema },
      additionalProperties: false,
    },
    handler: (args) =>
      withData((ctx) => {
        const range = resolveRange(ctx, args);
        const project = resolveProject(ctx, args);
        const stats = collectPeriodStats(ctx.db, range, statsOptions(ctx.config, { projectId: project?.id, topFiles: 10 }));
        return json({ ...(project ? { project: project.name } : {}), ...summarizeStats(stats) });
      }),
  },
  {
    name: 'get_standup',
    title: 'Daily standup',
    description:
      'Get a standup summary: what was done on the last active day before today, what has been done today so far, and blockers (most frequently failing commands). Returns both a ready-to-paste text and structured data.',
    inputSchema: { type: 'object', properties: { date: dateSchema }, additionalProperties: false },
    handler: (args) =>
      withData((ctx) => {
        const date = str(args, 'date');
        let target = ctx.now;
        if (date) {
          const r = parseDay(date);
          if (!r) throw new Error(`Invalid date: ${date} (expected YYYY-MM-DD)`);
          target = new Date(r.end.getTime() - 1);
        }
        const data = collectStandup(ctx.db, target, statsOptions(ctx.config));
        return json({ text: renderStandup(data, ctx.now), data: buildStandupPayload(data) });
      }),
  },
  {
    name: 'list_projects',
    title: 'Projects',
    description: 'List all projects DevTrack has recorded, with path, Git remote, first/last activity and totals for the given period.',
    inputSchema: { type: 'object', properties: { period: { ...periodSchema, description: 'Range for the totals. Default: all.' } }, additionalProperties: false },
    handler: (args) =>
      withData((ctx) => {
        const range = resolveRange(ctx, { period: 'all', ...args });
        const stats = collectPeriodStats(ctx.db, range, statsOptions(ctx.config, { topFiles: 0 }));
        const byId = new Map(stats.projects.map((p) => [p.id, p]));
        return json(
          listProjects(ctx.db).map((p) => {
            const s = byId.get(p.id);
            return {
              name: p.name,
              path: p.path,
              gitRemote: p.git_remote,
              firstRecorded: p.created_at,
              lastActive: p.updated_at,
              activeHours: toHours(s?.activeSeconds ?? 0),
              sessions: s?.sessions ?? 0,
              commits: s?.commits ?? 0,
            };
          }),
        );
      }),
  },
  {
    name: 'search_sessions',
    title: 'Search Claude Code sessions',
    description:
      'List recorded Claude Code sessions with time, project, branch, active time, status and title/AI summary. Optionally filter by text contained in the title, summary or branch (e.g. a ticket id).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive text to match in title, summary or branch.' },
        period: { ...periodSchema, description: 'Default: this_month.' },
        date: dateSchema,
        project: projectSchema,
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum sessions to return (newest first). Default: 20.' },
      },
      additionalProperties: false,
    },
    handler: (args) =>
      withData((ctx) => {
        const range = resolveRange(ctx, { period: 'this_month', ...args });
        const project = resolveProject(ctx, args);
        const stats = collectPeriodStats(ctx.db, range, statsOptions(ctx.config, { projectId: project?.id, topFiles: 0 }));
        const query = str(args, 'query')?.toLowerCase();
        const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(100, Math.floor(args.limit))) : 20;
        const sessions = [...stats.sessions]
          .filter((s) => !query || [s.title, s.summary, s.branch].some((v) => v?.toLowerCase().includes(query)))
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        return json({
          total: sessions.length,
          sessions: sessions.slice(0, limit).map((s) => ({
            project: s.projectName,
            started: s.startedAt,
            ended: s.endedAt,
            activeMinutes: Math.round(s.activeSeconds / 60),
            status: s.status,
            branch: s.branch,
            title: s.title,
            summary: s.summary,
            model: s.model,
          })),
        });
      }),
  },
  {
    name: 'get_token_usage',
    title: 'Token usage and cost',
    description:
      'Token usage and estimated cost (USD, based on Anthropic list prices) per model and per project. Only available when the user enabled collect.tokenUsage in DevTrack.',
    inputSchema: {
      type: 'object',
      properties: { period: { ...periodSchema, description: 'Default: this_month.' }, date: dateSchema, project: projectSchema },
      additionalProperties: false,
    },
    handler: (args) =>
      withData((ctx) => {
        const range = resolveRange(ctx, { period: 'this_month', ...args });
        const project = resolveProject(ctx, args);
        const stats = collectPeriodStats(ctx.db, range, statsOptions(ctx.config, { projectId: project?.id, topFiles: 0 }));
        if (!stats.tokens) {
          return json({
            period: stats.range.label,
            tokens: null,
            note: ctx.config.collect.tokenUsage
              ? 'No token usage recorded in this period.'
              : 'Token usage collection is disabled. Enable it with: devtrack config set collect.tokenUsage true',
          });
        }
        const round = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);
        return json({
          period: stats.range.label,
          from: formatDate(range.start),
          total: stats.tokens.total,
          estimatedCostUSD: round(stats.tokens.cost),
          unpricedTokens: stats.tokens.unpricedTokens,
          byModel: stats.tokens.byModel.map((m) => ({
            model: m.model,
            requests: m.messages,
            input: m.input,
            output: m.output,
            cacheRead: m.cacheRead,
            cacheWrite: m.cacheWrite,
            estimatedCostUSD: round(m.cost),
          })),
          byProject: stats.projects
            .filter((p) => p.tokens > 0)
            .map((p) => ({ project: p.name, tokens: p.tokens, estimatedCostUSD: round(p.cost) })),
          note: 'Estimated from list prices; subscription plans (Pro / Max) are not billed per token.',
        });
      }),
  },
];

export const INSTRUCTIONS =
  "DevTrack records the user's local development activity (Claude Code sessions, active time, Git commits, files, commands, tasks, token usage). Use these read-only tools to answer questions about what the user worked on, time spent per project or ticket, and cost. All data stays on the user's machine.";
