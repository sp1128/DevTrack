import type { AiProvider, DevTrackConfig } from '../config.js';
import { toHours } from '../core/format.js';
import type { PeriodStats } from '../stats/queries.js';

export interface AiResult {
  text: string;
  provider: AiProvider;
  model: string;
}

export class AiError extends Error {}

const DEFAULT_MODELS: Partial<Record<AiProvider, string>> = {
  anthropic: 'claude-opus-5',
  deepseek: 'deepseek-chat',
};

const DEFAULT_BASE_URLS: Partial<Record<AiProvider, string>> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
};

const DEFAULT_KEY_ENVS: Record<AiProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  'openai-compatible': 'DEVTRACK_AI_API_KEY',
};

/** 支持服务端拒答回退（fallbacks: "default"）的模型 */
const FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1']);

const SYSTEM_PROMPT = [
  '你是一名资深软件工程师的周报助手。用户会提供一周的开发统计数据（JSON，由本地工具 DevTrack 自动采集）。',
  '请用简体中文撰写本周开发总结，要求：',
  '1. 只依据给定数据，不要编造数据中没有的工作内容、数字或结论；数据不足时如实说明。',
  '2. 使用 Markdown，依次包含小节：### 本周工作概述、### 各项目进展、### 问题与风险、### 下周建议。',
  '3. 总长度控制在 600 字以内，语言简洁、具体。',
  '4. 直接输出正文，不要重复输出“AI 总结”之类的标题。',
].join('\n');

/**
 * 构建发送给 AI 的数据：只包含统计数字、项目名、任务标题与提交说明（均已脱敏），
 * 不包含源代码、命令原文、对话内容；文件路径默认不发送（ai.includeFilePaths）。
 */
export function buildAiPayload(stats: PeriodStats, config: DevTrackConfig): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    period: stats.range.label,
    range: { start: stats.range.start, end: stats.range.end },
    totals: {
      activeHours: toHours(stats.activeSeconds),
      activeDays: stats.activeDays,
      sessions: stats.sessions.length,
      prompts: stats.prompts,
      projects: stats.projects.length,
      commits: stats.commitTotals.count,
      insertions: stats.commitTotals.insertions,
      deletions: stats.commitTotals.deletions,
      filesModified: stats.files.distinct,
      fileEdits: stats.files.edits,
      commands: stats.commands.total,
      failedCommands: stats.commands.failed,
      tasksCompleted: stats.tasks.completed.length,
      tasksOpen: stats.tasks.open,
    },
    daily: stats.daily.map((d) => ({ date: d.date, activeHours: toHours(d.activeSeconds), commits: d.commits })),
    projects: stats.projects.map((p) => ({
      name: p.name,
      activeHours: toHours(p.activeSeconds),
      sessions: p.sessions,
      commits: p.commits,
      insertions: p.insertions,
      deletions: p.deletions,
      files: p.files,
      commandFailures: p.commandFailures,
      tasksCompleted: p.tasksCompleted,
    })),
    completedTasks: stats.tasks.completed.map((t) => ({ project: t.projectName, title: t.title })),
    commits: stats.commits.slice(0, 60).map((c) => ({ project: c.projectName, date: c.timestamp.slice(0, 10), message: c.message })),
    commandStats: stats.commands.byCategory,
    commandFailures: stats.commands.failures
      .slice(0, 10)
      .map((f) => ({ category: f.category, project: f.projectName, count: f.count })),
    toolUsage: stats.tools.slice(0, 15),
  };
  const titles = stats.sessions.map((s) => s.title).filter((t): t is string => !!t);
  if (titles.length > 0) payload.sessionTitles = titles.slice(0, 30);
  if (config.ai.includeFilePaths) {
    payload.topFiles = stats.files.top.map((f) => ({ project: f.projectName, path: f.path, edits: f.edits }));
  }
  return payload;
}

export function resolveModel(config: DevTrackConfig): string {
  const model = config.ai.model ?? DEFAULT_MODELS[config.ai.provider];
  if (!model) {
    throw new AiError(`provider 为 ${config.ai.provider} 时需要指定模型：devtrack config set ai.model <模型名>`);
  }
  return model;
}

function resolveApiKey(config: DevTrackConfig, env: NodeJS.ProcessEnv): string | undefined {
  const names = [config.ai.apiKeyEnv, 'DEVTRACK_AI_API_KEY', DEFAULT_KEY_ENVS[config.ai.provider]].filter(
    (n): n is string => !!n,
  );
  for (const name of names) {
    const value = env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

function userPrompt(payload: Record<string, unknown>): string {
  return `以下是本周的开发统计数据：\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

/** Anthropic 客户端的最小接口（便于测试时注入替身）。 */
export interface AnthropicLike {
  beta: {
    messages: {
      create(params: Record<string, unknown>): Promise<{
        stop_reason: string | null;
        model: string;
        content: { type: string; text?: string }[];
      }>;
    };
  };
}

export interface AiDeps {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  createAnthropic?: (options: { apiKey?: string; baseURL?: string; timeout: number }) => Promise<AnthropicLike>;
}

async function defaultCreateAnthropic(options: { apiKey?: string; baseURL?: string; timeout: number }): Promise<AnthropicLike> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    timeout: options.timeout,
    maxRetries: 2,
  }) as unknown as AnthropicLike;
}

async function callAnthropic(
  config: DevTrackConfig,
  model: string,
  payload: Record<string, unknown>,
  deps: AiDeps,
): Promise<AiResult> {
  const env = deps.env ?? process.env;
  // 未设置 API Key 时交给 SDK 按官方顺序解析凭据（ANTHROPIC_API_KEY、ANTHROPIC_AUTH_TOKEN、ant auth 登录配置等）
  const apiKey = resolveApiKey(config, env);
  let client: AnthropicLike;
  try {
    client = await (deps.createAnthropic ?? defaultCreateAnthropic)({
      apiKey,
      baseURL: config.ai.baseUrl,
      timeout: config.ai.timeoutSeconds * 1000,
    });
  } catch (err) {
    throw new AiError(`无法创建 Anthropic 客户端：${(err as Error).message}。请设置 ANTHROPIC_API_KEY。`);
  }
  // 官方 API 上为 Opus 5 / Fable 5.1 开启服务端拒答回退（自定义 baseUrl 的网关可能不支持该 beta，跳过）
  const useFallbacks = !config.ai.baseUrl && FALLBACK_MODELS.has(model);
  let response: Awaited<ReturnType<AnthropicLike['beta']['messages']['create']>>;
  try {
    response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt(payload) }],
      ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    });
  } catch (err) {
    throw new AiError(await describeAnthropicError(err));
  }
  if (response.stop_reason === 'refusal') throw new AiError('模型拒绝了本次请求（stop_reason: refusal）');
  const text = response.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text) throw new AiError('AI 返回了空内容');
  return { text, provider: 'anthropic', model: response.model || model };
}

async function describeAnthropicError(err: unknown): Promise<string> {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    if (err instanceof Anthropic.AuthenticationError) return '认证失败：请检查 ANTHROPIC_API_KEY 是否正确';
    if (err instanceof Anthropic.PermissionDeniedError) return '没有权限使用该模型，请检查账号或更换 ai.model';
    if (err instanceof Anthropic.NotFoundError) return '模型不存在，请检查 ai.model 配置';
    if (err instanceof Anthropic.RateLimitError) return '请求过于频繁（429），请稍后重试';
    if (err instanceof Anthropic.BadRequestError) return `请求参数错误：${err.message}`;
    if (err instanceof Anthropic.APIConnectionError) return `无法连接 Anthropic API：${err.message}`;
    if (err instanceof Anthropic.APIError) return `Anthropic API 错误 ${err.status ?? ''}：${err.message}`;
  } catch {
    // SDK 加载失败时退回通用信息
  }
  return (err as Error)?.message ?? String(err);
}

async function callOpenAICompatible(
  config: DevTrackConfig,
  model: string,
  payload: Record<string, unknown>,
  deps: AiDeps,
): Promise<AiResult> {
  const env = deps.env ?? process.env;
  const provider = config.ai.provider;
  const apiKey = resolveApiKey(config, env);
  if (!apiKey) {
    const name = config.ai.apiKeyEnv ?? DEFAULT_KEY_ENVS[provider];
    throw new AiError(`未找到 API Key，请设置环境变量 ${name}（或 DEVTRACK_AI_API_KEY）`);
  }
  const base = config.ai.baseUrl ?? DEFAULT_BASE_URLS[provider];
  if (!base) throw new AiError('provider 为 openai-compatible 时需要设置 ai.baseUrl，例如 https://api.example.com/v1');
  const url = `${base.replace(/\/+$/, '')}/chat/completions`;
  const doFetch = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt(payload) },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(config.ai.timeoutSeconds * 1000),
    });
  } catch (err) {
    throw new AiError(`请求 ${url} 失败：${(err as Error).message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new AiError(`AI 接口返回 HTTP ${res.status}：${body.slice(0, 300)}`);
  }
  const data = (await res.json().catch(() => null)) as {
    model?: string;
    choices?: { message?: { content?: unknown } }[];
  } | null;
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new AiError('AI 返回了空内容或无法解析的响应');
  return { text: content.trim(), provider, model: data?.model ?? model };
}

export async function generateAiSummary(stats: PeriodStats, config: DevTrackConfig, deps: AiDeps = {}): Promise<AiResult> {
  const model = resolveModel(config);
  const payload = buildAiPayload(stats, config);
  if (config.ai.provider === 'anthropic') return callAnthropic(config, model, payload, deps);
  return callOpenAICompatible(config, model, payload, deps);
}
