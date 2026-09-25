/**
 * Claude Code Hook 的 stdin 输入（依据官方文档 https://code.claude.com/docs/en/hooks）。
 *
 * Hook 路径使用手写校验，不加载 zod（每次启动可节省约 40ms）。规则与 schema.ts 中的
 * HookInputSchema 一致：必填字段缺失时报错；可选字段类型不符时忽略该字段，而不是整体失败，
 * 这样 Claude Code 未来调整某个字段的类型时，Hook 仍能记录其余信息。
 */
export interface HookInput {
  // 通用字段
  session_id: string;
  hook_event_name: string;
  cwd?: string;
  transcript_path?: string;
  scratchpad_dir?: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
  // SessionStart
  source?: string;
  model?: string;
  session_title?: string;
  // SessionEnd
  reason?: string;
  // UserPromptSubmit（只读取长度，默认不保存内容）
  prompt?: string;
  // PostToolUse / PostToolUseFailure
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  duration_ms?: number;
  error?: unknown;
  is_interrupt?: boolean;
  // TaskCreated / TaskCompleted
  task_id?: string;
  task_subject?: string;
  task_description?: string;
}

/** DevTrack 注册的 Hook 事件。 */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'TaskCreated',
  'TaskCompleted',
  'SessionEnd',
] as const;

export type HookEventName = (typeof HOOK_EVENTS)[number];

const STRING_FIELDS = [
  'cwd',
  'transcript_path',
  'scratchpad_dir',
  'permission_mode',
  'agent_id',
  'agent_type',
  'source',
  'model',
  'session_title',
  'reason',
  'prompt',
  'tool_name',
  'tool_use_id',
  'task_subject',
  'task_description',
] as const;

export type ParseResult = { success: true; data: HookInput } | { success: false; error: string };

/** 校验并提取 Hook 输入。 */
export function parseHookInput(payload: unknown): ParseResult {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { success: false, error: '(root): expected object' };
  }
  const raw = payload as Record<string, unknown>;
  const missing = (['session_id', 'hook_event_name'] as const).filter(
    (k) => typeof raw[k] !== 'string' || (raw[k] as string).length === 0,
  );
  if (missing.length > 0) return { success: false, error: missing.map((k) => `${k}: required non-empty string`).join('; ') };

  const data: HookInput = { session_id: raw.session_id as string, hook_event_name: raw.hook_event_name as string };
  const out = data as unknown as Record<string, unknown>;
  for (const key of STRING_FIELDS) {
    if (typeof raw[key] === 'string') out[key] = raw[key];
  }
  const toolInput = raw.tool_input;
  if (toolInput !== null && typeof toolInput === 'object' && !Array.isArray(toolInput)) {
    data.tool_input = toolInput as Record<string, unknown>;
  }
  if ('tool_response' in raw) data.tool_response = raw.tool_response;
  if ('error' in raw) data.error = raw.error;
  if (typeof raw.duration_ms === 'number' && Number.isFinite(raw.duration_ms)) data.duration_ms = raw.duration_ms;
  if (typeof raw.is_interrupt === 'boolean') data.is_interrupt = raw.is_interrupt;
  if (typeof raw.task_id === 'string' || (typeof raw.task_id === 'number' && Number.isFinite(raw.task_id))) {
    data.task_id = String(raw.task_id);
  }
  return { success: true, data };
}
