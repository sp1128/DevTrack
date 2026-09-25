import fs from 'node:fs';
import type { DevTrackConfig } from './config.js';

/**
 * Hook 专用的轻量配置读取（不加载 zod）。
 *
 * Hook 每次工具调用都会启动一次，加载 zod 约占 40ms。这里按与 ConfigSchema 相同的规则手工校验常见配置；
 * 遇到任何不确定的情况（校验失败、usage.prices 等复杂字段）返回 null，由调用方退回到完整的 zod 校验，
 * 因此结果与 loadConfig 完全一致（test/config-lite.test.ts 对比两者）。
 */

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

type Json = Record<string, unknown>;

/** 校验失败时抛出，由 parseConfigLite 捕获后返回 null */
class Invalid extends Error {}

const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

function section(raw: Json, key: string): Json {
  const v = raw[key];
  if (v === undefined) return {};
  if (!isObject(v)) throw new Invalid(key);
  return v;
}

function bool(o: Json, key: string, def: boolean): boolean {
  const v = o[key];
  if (v === undefined) return def;
  if (typeof v !== 'boolean') throw new Invalid(key);
  return v;
}

function int(o: Json, key: string, def: number, min: number, max: number): number {
  const v = o[key];
  if (v === undefined) return def;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Invalid(key);
  return v;
}

function strArray(o: Json, key: string, def: string[], minLength = 0): string[] {
  const v = o[key];
  if (v === undefined) return [...def];
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string' && s.length >= minLength)) throw new Invalid(key);
  return [...v] as string[];
}

function oneOf<T extends string>(o: Json, key: string, def: T, values: readonly T[]): T {
  const v = o[key];
  if (v === undefined) return def;
  if (typeof v !== 'string' || !values.includes(v as T)) throw new Invalid(key);
  return v as T;
}

function optStr(o: Json, key: string): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length < 1) throw new Invalid(key);
  return v;
}

/** 与 ConfigSchema.parse 等价的轻量解析；无法确定时返回 null。 */
export function parseConfigLite(raw: unknown): DevTrackConfig | null {
  try {
    if (!isObject(raw)) return null;
    if (raw.version !== undefined && raw.version !== 1) return null;
    const collect = section(raw, 'collect');
    const privacy = section(raw, 'privacy');
    const commands = section(raw, 'commands');
    const git = section(raw, 'git');
    const retention = section(raw, 'retention');
    const usage = section(raw, 'usage');
    const report = section(raw, 'report');
    const activity = section(raw, 'activity');
    const ai = section(raw, 'ai');
    // 自定义价格表结构较复杂，交给 zod 校验
    if (usage.prices !== undefined && !(isObject(usage.prices) && Object.keys(usage.prices).length === 0)) return null;

    const aiConfig: DevTrackConfig['ai'] = {
      provider: oneOf(ai, 'provider', 'anthropic', ['anthropic', 'openai', 'deepseek', 'openai-compatible'] as const),
      includeFilePaths: bool(ai, 'includeFilePaths', false),
      timeoutSeconds: int(ai, 'timeoutSeconds', 120, 5, 600),
      sessionSummary: bool(ai, 'sessionSummary', false),
    };
    for (const key of ['model', 'baseUrl', 'apiKeyEnv', 'sessionSummaryModel'] as const) {
      const v = optStr(ai, key);
      if (v !== undefined) aiConfig[key] = v;
    }

    return {
      version: 1,
      enabled: bool(raw, 'enabled', true),
      lang: oneOf(raw, 'lang', 'zh', ['zh', 'en'] as const),
      collect: {
        commands: bool(collect, 'commands', true),
        fileChanges: bool(collect, 'fileChanges', true),
        git: bool(collect, 'git', true),
        tasks: bool(collect, 'tasks', true),
        promptSummary: bool(collect, 'promptSummary', false),
        tokenUsage: bool(collect, 'tokenUsage', false),
      },
      privacy: {
        redactPatterns: strArray(privacy, 'redactPatterns', []),
        excludeProjects: strArray(privacy, 'excludeProjects', []),
      },
      commands: {
        ignore: strArray(commands, 'ignore', DEFAULT_IGNORED_COMMANDS),
        maxLength: int(commands, 'maxLength', 300, 40, 4000),
      },
      git: {
        authorOnly: bool(git, 'authorOnly', true),
        authorEmails: strArray(git, 'authorEmails', [], 3),
        backfillDays: int(git, 'backfillDays', 14, 0, 365),
        trackWorkingTree: bool(git, 'trackWorkingTree', true),
      },
      retention: { days: int(retention, 'days', 180, 0, 3650) },
      usage: { prices: {} },
      report: {
        autoWeekly: bool(report, 'autoWeekly', true),
        autoAi: bool(report, 'autoAi', false),
      },
      activity: { idleMinutes: int(activity, 'idleMinutes', 30, 1, 480) },
      ai: aiConfig,
    };
  } catch (err) {
    if (err instanceof Invalid) return null;
    throw err;
  }
}

/**
 * Hook 使用的配置读取：文件不存在时返回默认配置；轻量解析成功时直接返回；
 * 否则（JSON 错误、校验失败等）返回 null，由调用方使用完整的 loadConfigSafe。
 */
export function loadConfigFast(file: string): DevTrackConfig | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return parseConfigLite({});
    return null;
  }
  try {
    return parseConfigLite(JSON.parse(text));
  } catch {
    return null;
  }
}
