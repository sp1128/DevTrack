import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_EVENTS, type HookEventName } from './input.js';

/** 标记参数：用于识别 DevTrack 自己安装的 Hook，卸载 / 重装时不会误删用户的其他 Hook。 */
export const HOOK_MARKER = '--devtrack-managed';

/**
 * node：exec 形式，command = 当前 node 可执行文件绝对路径，args = [cli.js, hook]。
 *       不经过 shell，路径含空格也无需转义，Windows 下同样可用（需要 Claude Code v2.1.139+）。
 * path：shell 形式，command = "devtrack hook"，依赖 PATH 中的 devtrack 命令（兼容旧版 Claude Code）。
 */
export type HookCommandMode = 'node' | 'path';

/** 工具类事件使用 "*" 匹配所有工具；其余事件不支持或不需要 matcher。 */
const TOOL_EVENTS = new Set<HookEventName>(['PostToolUse', 'PostToolUseFailure']);

type Json = Record<string, unknown>;

export function getCliScriptPath(): string {
  // 编译后本文件位于 dist/hooks/install.js，cli 位于 dist/cli.js
  return fileURLToPath(new URL('../cli.js', import.meta.url));
}

export function buildHookHandler(
  event: HookEventName,
  mode: HookCommandMode,
  cliPath: string = getCliScriptPath(),
  nodePath: string = process.execPath,
): Json {
  const handler: Json = { type: 'command' };
  if (mode === 'node') {
    handler.command = nodePath;
    handler.args = [cliPath, 'hook', HOOK_MARKER];
  } else {
    handler.command = `devtrack hook ${HOOK_MARKER}`;
  }
  if (event === 'SessionEnd') {
    // SessionEnd 必须同步执行（退出时后台 Hook 会被终止）。
    // 默认预算只有 1.5 秒，设置 timeout 可以把预算提高到 5 秒。
    handler.timeout = 5;
  } else {
    // 其余事件后台异步执行，完全不阻塞 Claude
    handler.async = true;
  }
  return handler;
}

export function isDevTrackHandler(handler: unknown): boolean {
  if (!handler || typeof handler !== 'object') return false;
  const h = handler as Json;
  if (Array.isArray(h.args) && h.args.includes(HOOK_MARKER)) return true;
  return typeof h.command === 'string' && h.command.includes(HOOK_MARKER);
}

export class SettingsError extends Error {}

export function readSettings(file: string): Json {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new SettingsError(`无法解析 ${file}：${(err as Error).message}。为避免覆盖你的配置，请先修复该文件。`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SettingsError(`${file} 的顶层不是 JSON 对象，请先修复该文件。`);
  }
  return parsed as Json;
}

/** 从 settings 中移除所有 DevTrack Hook，返回移除的数量。会就地修改传入对象。 */
export function removeDevTrackHooks(settings: Json): number {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return 0;
  let removed = 0;
  const hooksObj = hooks as Json;
  for (const event of Object.keys(hooksObj)) {
    const groups = hooksObj[event];
    if (!Array.isArray(groups)) continue;
    const kept: unknown[] = [];
    for (const group of groups) {
      if (!group || typeof group !== 'object' || !Array.isArray((group as Json).hooks)) {
        kept.push(group);
        continue;
      }
      const handlers = (group as Json).hooks as unknown[];
      const remaining = handlers.filter((h) => !isDevTrackHandler(h));
      removed += handlers.length - remaining.length;
      if (remaining.length === handlers.length) kept.push(group);
      else if (remaining.length > 0) kept.push({ ...(group as Json), hooks: remaining });
    }
    if (kept.length > 0) hooksObj[event] = kept;
    else delete hooksObj[event];
  }
  if (Object.keys(hooksObj).length === 0) delete settings.hooks;
  return removed;
}

export function addDevTrackHooks(settings: Json, mode: HookCommandMode, cliPath?: string, nodePath?: string): void {
  if (settings.hooks !== undefined && (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) {
    throw new SettingsError('settings.json 中的 "hooks" 字段不是对象，请先修复。');
  }
  const hooks = (settings.hooks ?? {}) as Json;
  for (const event of HOOK_EVENTS) {
    const group: Json = {};
    if (TOOL_EVENTS.has(event)) group.matcher = '*';
    group.hooks = [buildHookHandler(event, mode, cliPath, nodePath)];
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    hooks[event] = [...existing, group];
  }
  settings.hooks = hooks;
}

function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.devtrack-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function backupFile(file: string, backupDir: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupDir, `claude-settings.${stamp}.json`);
  fs.copyFileSync(file, target);
  return target;
}

export interface InstallOptions {
  settingsPath: string;
  backupDir: string;
  mode?: HookCommandMode;
  cliPath?: string;
  nodePath?: string;
  /** 在 settings.env 中设置 CLAUDE_CODE_ENABLE_TODO_TOOLS=1，让新模型也启用任务工具 */
  enableTaskTools?: boolean;
}

export interface InstallResult {
  settingsPath: string;
  changed: boolean;
  backupPath?: string;
  events: readonly HookEventName[];
}

export function installHooks(options: InstallOptions): InstallResult {
  const original = readSettings(options.settingsPath);
  const next = structuredClone(original);
  removeDevTrackHooks(next);
  addDevTrackHooks(next, options.mode ?? 'node', options.cliPath, options.nodePath);
  if (options.enableTaskTools) {
    const env = next.env && typeof next.env === 'object' && !Array.isArray(next.env) ? (next.env as Json) : {};
    next.env = { ...env, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' };
  }
  const changed = JSON.stringify(original) !== JSON.stringify(next);
  let backupPath: string | undefined;
  if (changed) {
    backupPath = backupFile(options.settingsPath, options.backupDir);
    writeJsonAtomic(options.settingsPath, next);
  }
  return { settingsPath: options.settingsPath, changed, backupPath, events: HOOK_EVENTS };
}

export function uninstallHooks(options: { settingsPath: string; backupDir: string }): {
  removed: number;
  backupPath?: string;
} {
  if (!fs.existsSync(options.settingsPath)) return { removed: 0 };
  const settings = readSettings(options.settingsPath);
  const removed = removeDevTrackHooks(settings);
  if (removed === 0) return { removed: 0 };
  const backupPath = backupFile(options.settingsPath, options.backupDir);
  writeJsonAtomic(options.settingsPath, settings);
  return { removed, backupPath };
}

export interface HookInspection {
  settingsPath: string;
  exists: boolean;
  error?: string;
  disableAllHooks: boolean;
  installed: HookEventName[];
  missing: HookEventName[];
  mode?: HookCommandMode;
  problems: string[];
  taskToolsEnabled: boolean;
}

/** 检查 settings.json 中 DevTrack Hook 的安装状态（doctor 使用）。 */
export function inspectHooks(settingsPath: string): HookInspection {
  const result: HookInspection = {
    settingsPath,
    exists: fs.existsSync(settingsPath),
    disableAllHooks: false,
    installed: [],
    missing: [...HOOK_EVENTS],
    problems: [],
    taskToolsEnabled: false,
  };
  let settings: Json;
  try {
    settings = readSettings(settingsPath);
  } catch (err) {
    result.error = (err as Error).message;
    return result;
  }
  result.disableAllHooks = settings.disableAllHooks === true;
  const env = settings.env as Json | undefined;
  result.taskToolsEnabled = env?.CLAUDE_CODE_ENABLE_TODO_TOOLS === '1' || process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS === '1';
  const hooks = (settings.hooks ?? {}) as Json;
  const checked = new Set<string>();
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as Json[]) : [];
    const handler = groups
      .flatMap((g) => (g && Array.isArray(g.hooks) ? (g.hooks as Json[]) : []))
      .find((h) => isDevTrackHandler(h));
    if (!handler) continue;
    result.installed.push(event);
    result.mode = Array.isArray(handler.args) ? 'node' : 'path';
    if (Array.isArray(handler.args) && typeof handler.command === 'string') {
      const exe = handler.command;
      const script = String(handler.args[0] ?? '');
      for (const file of [exe, script]) {
        if (checked.has(file)) continue;
        checked.add(file);
        if (!fs.existsSync(file)) result.problems.push(`Hook 引用的文件不存在：${file}`);
      }
    }
  }
  result.missing = HOOK_EVENTS.filter((e) => !result.installed.includes(e));
  return result;
}
