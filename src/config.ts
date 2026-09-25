import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getPaths } from './paths.js';

/** 默认忽略的"琐碎"命令：只读 / 查看类命令不计入命令统计（仍计入工具调用次数）。 */
export const DEFAULT_IGNORED_COMMANDS = [
  'ls',
  'll',
  'la',
  'dir',
  'pwd',
  'cd',
  'cat',
  'bat',
  'head',
  'tail',
  'less',
  'more',
  'echo',
  'printf',
  'wc',
  'which',
  'where',
  'type',
  'whoami',
  'date',
  'clear',
  'true',
  'sleep',
  'file',
  'stat',
  'tree',
  'du',
  'df',
  'sort',
  'uniq',
  'grep',
  'rg',
  'find',
  'fd',
  'jq',
  'git status',
  'git diff',
  'git log',
  'git show',
  'git branch',
  'git remote',
  'git rev-parse',
  'git ls-files',
  'git blame',
];

export const AI_PROVIDERS = ['anthropic', 'openai', 'deepseek', 'openai-compatible'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  /** 总开关：false 时 Hook 收到事件后直接忽略，不写入任何数据。 */
  enabled: z.boolean().default(true),
  /** 各类数据采集开关。会话与工具调用事件（不含任何内容）始终记录，用于计算开发时长。 */
  collect: z
    .object({
      commands: z.boolean().default(true),
      fileChanges: z.boolean().default(true),
      git: z.boolean().default(true),
      tasks: z.boolean().default(true),
      /** 保存每个会话首条提示词的前 80 个字符（脱敏后）作为会话标题。默认关闭。 */
      promptSummary: z.boolean().default(false),
    })
    .prefault({}),
  privacy: z
    .object({
      /** 额外的脱敏正则（字符串形式），匹配内容替换为 [REDACTED]。 */
      redactPatterns: z.array(z.string()).default([]),
      /** 不记录的项目：项目名，或路径前缀。 */
      excludeProjects: z.array(z.string()).default([]),
    })
    .prefault({}),
  commands: z
    .object({
      ignore: z.array(z.string()).default(DEFAULT_IGNORED_COMMANDS),
      maxLength: z.number().int().min(40).max(4000).default(300),
    })
    .prefault({}),
  git: z
    .object({
      /** 只统计当前 git 用户（git config user.email）的提交。 */
      authorOnly: z.boolean().default(true),
      /** authorOnly 开启时，除仓库的 user.email 外也算作"自己"的邮箱（公司 / 个人 / 旧邮箱等）。 */
      authorEmails: z.array(z.string().min(3)).default([]),
      /** 首次发现项目时回溯读取多少天内的提交。 */
      backfillDays: z.number().int().min(0).max(365).default(14),
      /** 通过 git status 快照补充记录 Bash 或编辑器造成的文件变化。 */
      trackWorkingTree: z.boolean().default(true),
    })
    .prefault({}),
  retention: z
    .object({
      /** 自动删除多少天之前的数据（每天最多检查一次）；0 表示永久保留。 */
      days: z.number().int().min(0).max(3650).default(180),
    })
    .prefault({}),
  activity: z
    .object({
      /** 两次活动间隔超过该分钟数视为空闲，不计入开发时长。 */
      idleMinutes: z.number().int().min(1).max(480).default(30),
    })
    .prefault({}),
  ai: z
    .object({
      provider: z.enum(AI_PROVIDERS).default('anthropic'),
      model: z.string().min(1).optional(),
      baseUrl: z.string().min(1).optional(),
      /** 读取 API Key 的环境变量名。API Key 不会写入配置文件。 */
      apiKeyEnv: z.string().min(1).optional(),
      /** 是否把文件路径发送给 AI（默认只发送统计数字）。 */
      includeFilePaths: z.boolean().default(false),
      timeoutSeconds: z.number().int().min(5).max(600).default(120),
    })
    .prefault({}),
});

export type DevTrackConfig = z.infer<typeof ConfigSchema>;

export function defaultConfig(): DevTrackConfig {
  return ConfigSchema.parse({});
}

export class ConfigError extends Error {}

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

/** 读取配置；文件不存在时返回默认配置，格式错误时抛出 ConfigError。 */
export function loadConfig(file: string = getPaths().configFile): DevTrackConfig {
  if (!fs.existsSync(file)) return defaultConfig();
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`配置文件不是合法的 JSON：${file}（${(err as Error).message}）`);
  }
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`配置文件校验失败：${file}（${formatZodError(result.error)}）`);
  }
  return result.data;
}

/** Hook 场景使用：配置有问题时退回默认值，绝不抛错。 */
export function loadConfigSafe(file?: string): { config: DevTrackConfig; error?: Error } {
  try {
    return { config: loadConfig(file) };
  } catch (err) {
    return { config: defaultConfig(), error: err as Error };
  }
}

export function saveConfig(config: DevTrackConfig, file: string = getPaths().configFile): void {
  const validated = ConfigSchema.parse(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(validated, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/** 按点号路径读取配置项，例如 collect.commands。 */
export function getConfigValue(config: DevTrackConfig, key: string): unknown {
  let cur: unknown = config;
  for (const part of key.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(part in (cur as Record<string, unknown>))) {
      throw new ConfigError(`未知的配置项：${key}`);
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** 解析命令行传入的配置值：优先按 JSON 解析（true/false/数字/数组），否则视为字符串。 */
export function parseConfigValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** 按点号路径设置配置项，并用 schema 校验结果。 */
export function setConfigValue(config: DevTrackConfig, key: string, value: unknown): DevTrackConfig {
  const parts = key.split('.');
  const clone = structuredClone(config) as Record<string, unknown>;
  let cur: Record<string, unknown> = clone;
  const defaults = defaultConfig() as unknown as Record<string, unknown>;
  let defCur: Record<string, unknown> | undefined = defaults;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = cur[part];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      throw new ConfigError(`未知的配置项：${key}`);
    }
    cur = next as Record<string, unknown>;
    defCur = defCur?.[part] as Record<string, unknown> | undefined;
  }
  const last = parts[parts.length - 1]!;
  // 只允许设置 schema 中存在的键（可选键如 ai.model 在默认值里不存在，单独放行）
  const optionalKeys = new Set(['ai.model', 'ai.baseUrl', 'ai.apiKeyEnv']);
  if (!(last in cur) && !(defCur && last in defCur) && !optionalKeys.has(key)) {
    throw new ConfigError(`未知的配置项：${key}`);
  }
  if (value === null || value === '') {
    if (!optionalKeys.has(key)) throw new ConfigError(`配置项 ${key} 不能为空`);
    delete cur[last];
  } else {
    cur[last] = value;
  }
  const result = ConfigSchema.safeParse(clone);
  if (!result.success) {
    throw new ConfigError(`配置值无效：${formatZodError(result.error)}`);
  }
  return result.data;
}
