import { estimateCost, type ModelPrice } from '../core/pricing.js';
import type { DB } from '../db/database.js';
import { eachDay, formatDate, type DateRange } from '../core/time.js';
import { buildIntervals, clipIntervals, summarizeIntervals, type ActivityPoint, type Interval } from './activity.js';

export interface SessionSummary {
  id: number;
  sessionId: string;
  projectId: number | null;
  projectName: string;
  title: string | null;
  /** AI 生成的一句话摘要（ai.sessionSummary） */
  summary: string | null;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  lastActivityAt: string;
  status: string;
  activeSeconds: number;
}

export interface ProjectSummary {
  id: number;
  name: string;
  path: string;
  gitRemote: string | null;
  activeSeconds: number;
  sessions: number;
  commits: number;
  insertions: number;
  deletions: number;
  files: number;
  fileEdits: number;
  commands: number;
  commandFailures: number;
  tasksCompleted: number;
  /** Token 总量（输入 + 输出 + 缓存读写） */
  tokens: number;
  /** 估算费用（美元）；没有可计价的用量时为 null */
  cost: number | null;
}

export interface FileSummary {
  projectId: number | null;
  projectName: string;
  path: string;
  edits: number;
  lastAction: string;
  created: boolean;
}

export interface CommitSummary {
  projectId: number;
  projectName: string;
  hash: string;
  branch: string | null;
  message: string;
  author: string;
  timestamp: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  withClaude: boolean;
}

export interface CommandFailure {
  command: string;
  category: string;
  projectName: string;
  count: number;
  lastExitCode: number | null;
  lastAt: string;
}

export interface TaskSummary {
  title: string;
  projectName: string;
  status: string;
  source: string;
  createdAt: string;
  completedAt: string | null;
}

export interface DailySummary {
  date: string;
  activeSeconds: number;
  sessions: number;
  commits: number;
  fileEdits: number;
  commands: number;
  tokens: number;
  cost: number | null;
}

export interface TokenBreakdown {
  messages: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 以上四项之和 */
  total: number;
  /** 估算费用（美元）：只包含价格已知的模型；全部未知时为 null */
  cost: number | null;
}

export interface TokenStats extends TokenBreakdown {
  /** 价格未知、没有计入费用的 token 数 */
  unpricedTokens: number;
  byModel: (TokenBreakdown & { model: string })[];
}

export interface PeriodStats {
  range: { start: string; end: string; label: string };
  activeSeconds: number;
  activeDays: number;
  sessions: SessionSummary[];
  runningSessions: number;
  prompts: number;
  tools: { tool: string; count: number; failures: number }[];
  projects: ProjectSummary[];
  files: {
    distinct: number;
    edits: number;
    created: number;
    deleted: number;
    top: FileSummary[];
  };
  commits: CommitSummary[];
  commitTotals: { count: number; insertions: number; deletions: number; filesChanged: number };
  commands: {
    total: number;
    failed: number;
    byCategory: { category: string; total: number; failed: number }[];
    failures: CommandFailure[];
  };
  tasks: { created: number; open: number; completed: TaskSummary[] };
  daily: DailySummary[];
  /** Token 用量与估算费用（需开启 collect.tokenUsage）；没有记录时为 null */
  tokens: TokenStats | null;
}

export interface StatsOptions {
  idleMinutes: number;
  /** 只统计指定项目 */
  projectId?: number;
  /** 文件 Top N */
  topFiles?: number;
  /** 补充或覆盖的模型价格（配置 usage.prices） */
  prices?: Record<string, ModelPrice>;
}

interface ProjectRef {
  id: number;
  name: string;
  path: string;
  git_remote: string | null;
}

export function collectPeriodStats(db: DB, range: DateRange, options: StatsOptions): PeriodStats {
  const start = range.start.toISOString();
  const end = range.end.toISOString();
  const idleMs = options.idleMinutes * 60_000;
  const pid = options.projectId ?? null;
  const projectFilter = (col: string) => (pid === null ? '' : ` AND ${col} = ${Number(pid)}`);

  const projectRows = db.prepare('SELECT id, name, path, git_remote FROM projects').all() as ProjectRef[];
  const projectsById = new Map(projectRows.map((p) => [p.id, p]));
  const projectName = (id: number | null) => (id !== null ? (projectsById.get(id)?.name ?? '(未知项目)') : '(未知项目)');

  // ---- 活跃时长 ----
  const padStart = new Date(range.start.getTime() - idleMs).toISOString();
  const padEnd = new Date(range.end.getTime() + idleMs).toISOString();
  // 流式读取原始行（数组而非对象），直接构造活跃点，减少大数据量时的内存分配与 GC
  const points: ActivityPoint[] = [];
  const pointStmt = db
    .prepare(
      `SELECT session_id, project_id, timestamp FROM events
        WHERE session_id IS NOT NULL AND timestamp >= ? AND timestamp < ?${projectFilter('project_id')}
        ORDER BY session_id, timestamp`,
    )
    .raw(true);
  for (const row of pointStmt.iterate(padStart, padEnd) as Iterable<[number, number | null, string]>) {
    points.push({ sessionId: row[0], projectId: row[1], t: Date.parse(row[2]) });
  }
  const allIntervals = buildIntervals(points, idleMs);
  const intervals = clipIntervals(allIntervals, range.start.getTime(), range.end.getTime());
  const activity = summarizeIntervals(intervals);

  // ---- 会话 ----
  const sessionRows = db
    .prepare(
      `SELECT id, session_id, project_id, title, summary, model, started_at, ended_at, last_activity_at, status
         FROM sessions
        WHERE started_at < ? AND COALESCE(ended_at, last_activity_at) >= ?${projectFilter('project_id')}
        ORDER BY started_at`,
    )
    .all(end, start) as {
    id: number;
    session_id: string;
    project_id: number | null;
    title: string | null;
    summary: string | null;
    model: string | null;
    started_at: string;
    ended_at: string | null;
    last_activity_at: string;
    status: string;
  }[];
  const sessions: SessionSummary[] = sessionRows.map((s) => ({
    id: s.id,
    sessionId: s.session_id,
    projectId: s.project_id,
    projectName: projectName(s.project_id),
    title: s.title,
    summary: s.summary,
    model: s.model,
    startedAt: s.started_at,
    endedAt: s.ended_at,
    lastActivityAt: s.last_activity_at,
    status: s.status,
    activeSeconds: activity.bySession.get(s.id) ?? 0,
  }));

  // ---- 提示词与工具调用 ----
  const prompts = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM events WHERE type = 'prompt' AND timestamp >= ? AND timestamp < ?${projectFilter('project_id')}`,
      )
      .get(start, end) as { c: number }
  ).c;
  const tools = (
    db
      .prepare(
        `SELECT tool_name AS tool, COUNT(*) AS count, SUM(CASE WHEN type = 'tool_failure' THEN 1 ELSE 0 END) AS failures
           FROM events
          WHERE type IN ('tool_use', 'tool_failure') AND timestamp >= ? AND timestamp < ?${projectFilter('project_id')}
          GROUP BY tool_name ORDER BY count DESC`,
      )
      .all(start, end) as { tool: string | null; count: number; failures: number }[]
  ).map((t) => ({ tool: t.tool ?? 'unknown', count: t.count, failures: t.failures }));

  // ---- 文件修改 ----
  const fileRows = db
    .prepare(
      `SELECT project_id, file_path, action, timestamp FROM file_changes
        WHERE timestamp >= ? AND timestamp < ?${projectFilter('project_id')} ORDER BY timestamp`,
    )
    .all(start, end) as { project_id: number | null; file_path: string; action: string; timestamp: string }[];
  const fileMap = new Map<string, FileSummary>();
  for (const f of fileRows) {
    const key = `${f.project_id}\u0000${f.file_path}`;
    const cur = fileMap.get(key);
    if (cur) {
      cur.edits++;
      cur.lastAction = f.action;
      if (f.action === 'create') cur.created = true;
    } else {
      fileMap.set(key, {
        projectId: f.project_id,
        projectName: projectName(f.project_id),
        path: f.file_path,
        edits: 1,
        lastAction: f.action,
        created: f.action === 'create',
      });
    }
  }
  const allFiles = [...fileMap.values()];
  const topFiles = [...allFiles].sort((a, b) => b.edits - a.edits || a.path.localeCompare(b.path)).slice(0, options.topFiles ?? 10);

  // ---- Git 提交 ----
  const commitRows = db
    .prepare(
      `SELECT project_id, session_id, hash, branch, message, author, timestamp, files_changed, insertions, deletions
         FROM git_commits WHERE timestamp >= ? AND timestamp < ?${projectFilter('project_id')}
        ORDER BY timestamp DESC`,
    )
    .all(start, end) as {
    project_id: number;
    session_id: number | null;
    hash: string;
    branch: string | null;
    message: string | null;
    author: string | null;
    timestamp: string;
    files_changed: number;
    insertions: number;
    deletions: number;
  }[];
  const commits: CommitSummary[] = commitRows.map((c) => ({
    projectId: c.project_id,
    projectName: projectName(c.project_id),
    hash: c.hash,
    branch: c.branch,
    message: c.message ?? '',
    author: c.author ?? '',
    timestamp: c.timestamp,
    filesChanged: c.files_changed,
    insertions: c.insertions,
    deletions: c.deletions,
    withClaude: c.session_id !== null,
  }));

  // ---- 命令 ----
  const commandRows = db
    .prepare(
      `SELECT project_id, command, category, status, exit_code, timestamp FROM commands
        WHERE timestamp >= ? AND timestamp < ?${projectFilter('project_id')} ORDER BY timestamp`,
    )
    .all(start, end) as {
    project_id: number | null;
    command: string;
    category: string;
    status: string;
    exit_code: number | null;
    timestamp: string;
  }[];
  const byCategory = new Map<string, { category: string; total: number; failed: number }>();
  const failureMap = new Map<string, CommandFailure>();
  for (const c of commandRows) {
    const cat = byCategory.get(c.category) ?? { category: c.category, total: 0, failed: 0 };
    cat.total++;
    if (c.status === 'failure') {
      cat.failed++;
      const key = `${c.project_id}\u0000${c.command}`;
      const f = failureMap.get(key);
      if (f) {
        f.count++;
        f.lastExitCode = c.exit_code;
        f.lastAt = c.timestamp;
      } else {
        failureMap.set(key, {
          command: c.command,
          category: c.category,
          projectName: projectName(c.project_id),
          count: 1,
          lastExitCode: c.exit_code,
          lastAt: c.timestamp,
        });
      }
    }
    byCategory.set(c.category, cat);
  }

  // ---- 任务 ----
  const createdTasks = db
    .prepare(
      `SELECT status FROM tasks WHERE created_at >= ? AND created_at < ? AND status != 'deleted'${projectFilter('project_id')}`,
    )
    .all(start, end) as { status: string }[];
  const completedTasks = (
    db
      .prepare(
        `SELECT title, project_id, status, source, created_at, completed_at FROM tasks
          WHERE status = 'completed' AND completed_at >= ? AND completed_at < ?${projectFilter('project_id')}
          ORDER BY completed_at`,
      )
      .all(start, end) as {
      title: string;
      project_id: number | null;
      status: string;
      source: string;
      created_at: string;
      completed_at: string | null;
    }[]
  ).map((t) => ({
    title: t.title,
    projectName: projectName(t.project_id),
    status: t.status,
    source: t.source,
    createdAt: t.created_at,
    completedAt: t.completed_at,
  }));

  // ---- 按项目汇总 ----
  const projectMap = new Map<number, ProjectSummary>();
  const ensure = (id: number | null): ProjectSummary | undefined => {
    if (id === null) return undefined;
    let p = projectMap.get(id);
    if (!p) {
      const ref = projectsById.get(id);
      p = {
        id,
        name: ref?.name ?? '(未知项目)',
        path: ref?.path ?? '',
        gitRemote: ref?.git_remote ?? null,
        activeSeconds: activity.byProject.get(id) ?? 0,
        sessions: 0,
        commits: 0,
        insertions: 0,
        deletions: 0,
        files: 0,
        fileEdits: 0,
        commands: 0,
        commandFailures: 0,
        tasksCompleted: 0,
        tokens: 0,
        cost: null,
      };
      projectMap.set(id, p);
    }
    return p;
  };
  for (const id of activity.byProject.keys()) ensure(id);
  for (const s of sessions) {
    const p = ensure(s.projectId);
    if (p) p.sessions++;
  }
  for (const c of commits) {
    const p = ensure(c.projectId)!;
    p.commits++;
    p.insertions += c.insertions;
    p.deletions += c.deletions;
  }
  for (const f of allFiles) {
    const p = ensure(f.projectId);
    if (p) {
      p.files++;
      p.fileEdits += f.edits;
    }
  }
  for (const c of commandRows) {
    const p = ensure(c.project_id);
    if (p) {
      p.commands++;
      if (c.status === 'failure') p.commandFailures++;
    }
  }
  const completedByProject = db
    .prepare(
      `SELECT project_id, COUNT(*) AS c FROM tasks
        WHERE status = 'completed' AND completed_at >= ? AND completed_at < ?${projectFilter('project_id')}
        GROUP BY project_id`,
    )
    .all(start, end) as { project_id: number | null; c: number }[];
  for (const row of completedByProject) {
    const p = ensure(row.project_id);
    if (p) p.tasksCompleted = row.c;
  }

  // ---- Token 用量 ----
  const usageRows = db
    .prepare(
      `SELECT project_id, model, timestamp, input_tokens, output_tokens, cache_read_tokens,
              cache_write_5m_tokens, cache_write_1h_tokens
         FROM token_usage WHERE timestamp >= ? AND timestamp < ?${projectFilter('project_id')}`,
    )
    .raw(true)
    .all(start, end) as [number | null, string | null, string, number, number, number, number, number][];
  const emptyBreakdown = (): TokenBreakdown => ({ messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: null });
  const tokenTotals: TokenStats = { ...emptyBreakdown(), unpricedTokens: 0, byModel: [] };
  const byModel = new Map<string, TokenBreakdown & { model: string }>();
  const usageByDay: { ts: string; tokens: number; cost: number | null }[] = [];
  const addCost = (cur: number | null, add: number | null) => (add === null ? cur : (cur ?? 0) + add);
  for (const [projectId, model, ts, input, output, cacheRead, write5m, write1h] of usageRows) {
    const cacheWrite = write5m + write1h;
    const total = input + output + cacheRead + cacheWrite;
    const cost = estimateCost(model, { input, output, cacheRead, cacheWrite5m: write5m, cacheWrite1h: write1h }, options.prices);
    const name = model ?? '(未知模型)';
    let m = byModel.get(name);
    if (!m) byModel.set(name, (m = { model: name, ...emptyBreakdown() }));
    for (const b of [tokenTotals, m]) {
      b.messages++;
      b.input += input;
      b.output += output;
      b.cacheRead += cacheRead;
      b.cacheWrite += cacheWrite;
      b.total += total;
      b.cost = addCost(b.cost, cost);
    }
    if (cost === null) tokenTotals.unpricedTokens += total;
    const p = ensure(projectId);
    if (p) {
      p.tokens += total;
      p.cost = addCost(p.cost, cost);
    }
    usageByDay.push({ ts, tokens: total, cost });
  }
  tokenTotals.byModel = [...byModel.values()].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.total - a.total);
  const projects = [...projectMap.values()].sort(
    (a, b) => b.activeSeconds - a.activeSeconds || b.commits - a.commits || b.fileEdits - a.fileEdits,
  );

  // ---- 每日分布 ----
  const days = eachDay(range);
  const dayStarts = days.map((d) => d.getTime());
  const dayIndex = (t: number): number => {
    // 二分查找 t 所在的天
    let lo = 0;
    let hi = dayStarts.length - 1;
    if (t < range.start.getTime() || t >= range.end.getTime() || hi < 0) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (dayStarts[mid]! <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const daySessions = days.map(() => new Set<number>());
  for (const p of points) {
    const i = dayIndex(p.t);
    if (i >= 0) daySessions[i]!.add(p.sessionId);
  }
  // 一次遍历把每个活跃区间按天切分到各自的桶里（区间通常只跨一天），
  // 避免"每一天都扫描全部区间"带来的 O(天数 × 区间数) 开销
  const dayEndOf = (i: number) => (i + 1 < days.length ? dayStarts[i + 1]! : range.end.getTime());
  const dayBuckets: Interval[][] = days.map(() => []);
  for (const iv of intervals) {
    let i = dayIndex(iv.start);
    while (i >= 0 && i < days.length && dayStarts[i]! < iv.end) {
      const s = Math.max(iv.start, dayStarts[i]!);
      const e = Math.min(iv.end, dayEndOf(i));
      if (e > s) dayBuckets[i]!.push({ ...iv, start: s, end: e });
      i++;
    }
  }
  const daily: DailySummary[] = days.map((d, i) => {
    return {
      date: formatDate(d),
      activeSeconds: summarizeIntervals(dayBuckets[i]!).totalSeconds,
      sessions: daySessions[i]!.size,
      commits: 0,
      fileEdits: 0,
      commands: 0,
      tokens: 0,
      cost: null,
    };
  });
  const bump = (ts: string, field: 'commits' | 'fileEdits' | 'commands') => {
    const i = dayIndex(Date.parse(ts));
    if (i >= 0) daily[i]![field]++;
  };
  for (const c of commits) bump(c.timestamp, 'commits');
  for (const f of fileRows) bump(f.timestamp, 'fileEdits');
  for (const c of commandRows) bump(c.timestamp, 'commands');
  for (const u of usageByDay) {
    const i = dayIndex(Date.parse(u.ts));
    if (i < 0) continue;
    daily[i]!.tokens += u.tokens;
    daily[i]!.cost = addCost(daily[i]!.cost, u.cost);
  }

  return {
    range: { start, end, label: range.label },
    activeSeconds: activity.totalSeconds,
    activeDays: daily.filter((d) => d.activeSeconds > 0 || d.commits > 0).length,
    sessions,
    runningSessions: sessions.filter((s) => s.status === 'active').length,
    prompts,
    tools,
    projects,
    files: {
      distinct: allFiles.length,
      edits: fileRows.length,
      created: allFiles.filter((f) => f.created).length,
      deleted: allFiles.filter((f) => f.lastAction === 'delete').length,
      top: topFiles,
    },
    commits,
    commitTotals: {
      count: commits.length,
      insertions: commits.reduce((n, c) => n + c.insertions, 0),
      deletions: commits.reduce((n, c) => n + c.deletions, 0),
      filesChanged: commits.reduce((n, c) => n + c.filesChanged, 0),
    },
    commands: {
      total: commandRows.length,
      failed: commandRows.filter((c) => c.status === 'failure').length,
      byCategory: [...byCategory.values()].sort((a, b) => b.total - a.total),
      failures: [...failureMap.values()].sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt)),
    },
    tasks: {
      created: createdTasks.length,
      open: createdTasks.filter((t) => t.status === 'pending' || t.status === 'in_progress').length,
      completed: completedTasks,
    },
    daily,
    tokens: usageRows.length > 0 ? tokenTotals : null,
  };
}

/** 数据中最早的时间点（stats 全量统计使用）。 */
export function earliestRecord(db: DB): Date | null {
  const row = db
    .prepare(
      `SELECT MIN(t) AS t FROM (
         SELECT MIN(started_at) AS t FROM sessions
         UNION ALL SELECT MIN(timestamp) FROM git_commits
         UNION ALL SELECT MIN(timestamp) FROM events
       )`,
    )
    .get() as { t: string | null };
  return row.t ? new Date(row.t) : null;
}

export function lastEventTime(db: DB): Date | null {
  const row = db.prepare('SELECT MAX(timestamp) AS t FROM events').get() as { t: string | null };
  return row.t ? new Date(row.t) : null;
}
