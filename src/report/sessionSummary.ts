import type { DevTrackConfig } from '../config.js';
import { sanitizeText } from '../core/text.js';
import { getLang } from '../i18n.js';
import type { DB } from '../db/database.js';
import { buildIntervals, summarizeIntervals } from '../stats/activity.js';
import { AiError, completeText, resolveModel, type AiDeps, type AiResult } from './ai.js';

/**
 * 会话 AI 摘要：会话结束后，根据该会话的统计数据用一句话概括"这次会话做了什么"。
 *
 * 发送给 AI 的数据与周报相同的原则：只有统计数字、项目名、提交说明、任务标题（均已脱敏），
 * 不包含源代码、命令原文和对话内容；文件路径只在 ai.includeFilePaths 开启时发送。
 */

function systemPrompt(): string {
  if (getLang() === 'en') {
    return [
      'You are a development log assistant. The user provides statistics of one Claude Code programming session (JSON, collected automatically by the local tool DevTrack; no conversation content).',
      'Summarize what this session did in one English sentence (at most 20 words):',
      '1. Use only the given data; prefer commit messages, task titles, session title and modified files. Do not invent anything.',
      '2. If the data is not enough to tell the specific work, describe the activity objectively, e.g. "Modified 5 files in project xxx and ran tests".',
      '3. Output only that sentence, without quotes or prefixes.',
    ].join('\n');
  }
  return [
    '你是开发日志助手。用户会提供一次 Claude Code 编程会话的统计数据（JSON，由本地工具 DevTrack 自动采集，不含对话内容）。',
    '请用一句简体中文（不超过 60 个字）概括这次会话做了什么，要求：',
    '1. 只依据给定数据，优先参考提交说明、任务标题、会话标题与修改的文件；不要编造数据中没有的内容。',
    '2. 数据不足以判断具体内容时，客观描述活动，例如"在 xxx 项目中修改了 5 个文件并运行测试"。',
    '3. 只输出这一句话，不要加引号、前缀或句末以外的标点说明。',
  ].join('\n');
}

/** 会话摘要默认使用的模型：Anthropic 用更快、更便宜的 Haiku；其他提供商沿用 ai.model。 */
const DEFAULT_SUMMARY_MODELS: Partial<Record<DevTrackConfig['ai']['provider'], string>> = {
  anthropic: 'claude-haiku-4-5',
};

export function resolveSummaryModel(config: DevTrackConfig): string {
  return config.ai.sessionSummaryModel ?? DEFAULT_SUMMARY_MODELS[config.ai.provider] ?? resolveModel(config);
}

/** 摘要最长保存长度 */
const MAX_SUMMARY_LENGTH = 200;

interface SessionRef {
  id: number;
  session_id: string;
  project_id: number | null;
  title: string | null;
  started_at: string;
  ended_at: string | null;
  last_activity_at: string;
  status: string;
}

/** 构建单个会话发送给 AI 的数据；会话不存在或没有任何实际活动时返回 null。 */
export function buildSessionPayload(db: DB, sessionId: number, config: DevTrackConfig): Record<string, unknown> | null {
  const s = db
    .prepare(
      'SELECT id, session_id, project_id, title, started_at, ended_at, last_activity_at, status FROM sessions WHERE id = ?',
    )
    .get(sessionId) as SessionRef | undefined;
  if (!s) return null;
  const project = s.project_id !== null
    ? (db.prepare('SELECT name FROM projects WHERE id = ?').get(s.project_id) as { name: string } | undefined)
    : undefined;

  const events = db.prepare('SELECT type, tool_name, timestamp FROM events WHERE session_id = ? ORDER BY timestamp').all(s.id) as {
    type: string;
    tool_name: string | null;
    timestamp: string;
  }[];
  const idleMs = config.activity.idleMinutes * 60_000;
  const activeSeconds = summarizeIntervals(
    buildIntervals(
      events.map((e) => ({ sessionId: s.id, projectId: s.project_id, t: Date.parse(e.timestamp) })),
      idleMs,
    ),
  ).totalSeconds;
  const tools = new Map<string, number>();
  let prompts = 0;
  for (const e of events) {
    if (e.type === 'prompt') prompts++;
    if ((e.type === 'tool_use' || e.type === 'tool_failure') && e.tool_name) tools.set(e.tool_name, (tools.get(e.tool_name) ?? 0) + 1);
  }

  const files = db
    .prepare(
      `SELECT file_path AS path, COUNT(*) AS edits,
              MAX(CASE WHEN action = 'create' THEN 1 ELSE 0 END) AS created
         FROM file_changes WHERE session_id = ? GROUP BY file_path ORDER BY edits DESC`,
    )
    .all(s.id) as { path: string; edits: number; created: number }[];
  const commands = db
    .prepare(
      `SELECT category, COUNT(*) AS total, SUM(CASE WHEN status = 'failure' THEN 1 ELSE 0 END) AS failed
         FROM commands WHERE session_id = ? GROUP BY category ORDER BY total DESC`,
    )
    .all(s.id) as { category: string; total: number; failed: number }[];
  const commits = db.prepare('SELECT message FROM git_commits WHERE session_id = ? ORDER BY timestamp').all(s.id) as {
    message: string | null;
  }[];
  const tasks = db
    .prepare("SELECT title FROM tasks WHERE session_id = ? AND status = 'completed' ORDER BY completed_at")
    .all(s.id) as { title: string }[];

  const toolUses = [...tools.values()].reduce((n, c) => n + c, 0);
  if (toolUses === 0 && files.length === 0 && commits.length === 0 && tasks.length === 0) return null;

  const payload: Record<string, unknown> = {
    project: project?.name ?? '(未知项目)',
    date: s.started_at.slice(0, 10),
    activeMinutes: Math.round(activeSeconds / 60),
    prompts,
    toolUses: [...tools.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tool, count]) => ({ tool, count })),
    files: {
      modified: files.length,
      created: files.filter((f) => f.created).length,
      ...(config.ai.includeFilePaths ? { top: files.slice(0, 20).map((f) => ({ path: f.path, edits: f.edits })) } : {}),
    },
    commands,
    commits: commits.map((c) => c.message ?? '').filter(Boolean).slice(0, 20),
    completedTasks: tasks.map((t) => t.title).slice(0, 20),
  };
  if (s.title) payload.sessionTitle = s.title;
  return payload;
}

/** 把 AI 返回的文本整理成单行摘要，并再做一次脱敏。 */
export function cleanSummary(text: string, extraPatterns?: string[]): string {
  const line = text
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? '';
  const stripped = line
    .replace(/^[#>*\-\s]+/, '')
    .replace(/^(摘要|总结|概括|summary)[:：]\s*/i, '')
    .replace(/^["“「'](.*)["”」']$/, '$1')
    .trim();
  return sanitizeText(stripped, MAX_SUMMARY_LENGTH, extraPatterns);
}

export function userPrompt(payload: Record<string, unknown>): string {
  if (getLang() === 'en') return `Statistics of this session:\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
  return `以下是这次会话的统计数据：\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

/** 为一个会话生成并保存摘要。没有实际活动的会话返回 null（不调用 AI）。 */
export async function summarizeSession(
  db: DB,
  sessionId: number,
  config: DevTrackConfig,
  now: Date,
  deps: AiDeps = {},
): Promise<(AiResult & { summary: string }) | null> {
  const payload = buildSessionPayload(db, sessionId, config);
  if (!payload) return null;
  const model = resolveSummaryModel(config);
  const result = await completeText(config, model, { system: systemPrompt(), user: userPrompt(payload), maxTokens: 1024 }, deps);
  const summary = cleanSummary(result.text, config.privacy.redactPatterns);
  if (!summary) throw new AiError('AI 返回的摘要为空');
  db.prepare('UPDATE sessions SET summary = ?, summarized_at = ? WHERE id = ?').run(summary, now.toISOString(), sessionId);
  return { ...result, summary };
}

export interface PendingSession {
  id: number;
  sessionId: string;
  projectName: string;
  startedAt: string;
}

/** 需要生成摘要的会话：已结束、在指定时间之后开始、还没有摘要（force 时包括已有摘要的）。 */
export function findSessionsToSummarize(
  db: DB,
  options: { since: Date; force?: boolean; sessionId?: string; limit?: number },
): PendingSession[] {
  const where = ["s.status != 'active'", 's.started_at >= ?'];
  const params: unknown[] = [options.since.toISOString()];
  if (!options.force) where.push('s.summary IS NULL');
  if (options.sessionId) {
    where.push('s.session_id = ?');
    params.push(options.sessionId);
  }
  params.push(options.limit ?? 50);
  return (
    db
      .prepare(
        `SELECT s.id, s.session_id, s.started_at, p.name AS project_name
           FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
          WHERE ${where.join(' AND ')}
          ORDER BY s.started_at DESC LIMIT ?`,
      )
      .all(...params) as { id: number; session_id: string; started_at: string; project_name: string | null }[]
  ).map((r) => ({ id: r.id, sessionId: r.session_id, projectName: r.project_name ?? '(未知项目)', startedAt: r.started_at }));
}
