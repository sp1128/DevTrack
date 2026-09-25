import { z } from 'zod';

/**
 * Claude Code Hook 的 stdin 输入的 zod 版本（编程接口与测试使用；Hook 本身使用 input.ts 中的手写校验）。
 *
 * 只声明 DevTrack 需要的字段；每个可选字段都用 .catch(undefined) 容错，
 * 这样 Claude Code 未来调整某个字段的类型时，Hook 只会忽略该字段而不会整体失败。
 */
const optStr = z.string().optional().catch(undefined);
const optNum = z.number().optional().catch(undefined);
const optBool = z.boolean().optional().catch(undefined);

export const HookInputSchema = z.object({
  // 通用字段
  session_id: z.string().min(1),
  hook_event_name: z.string().min(1),
  cwd: optStr,
  transcript_path: optStr,
  scratchpad_dir: optStr,
  permission_mode: optStr,
  agent_id: optStr,
  agent_type: optStr,
  // SessionStart
  source: optStr,
  model: optStr,
  session_title: optStr,
  // SessionEnd
  reason: optStr,
  // UserPromptSubmit（只读取长度，默认不保存内容）
  prompt: optStr,
  // PostToolUse / PostToolUseFailure
  tool_name: optStr,
  tool_input: z.record(z.string(), z.unknown()).optional().catch(undefined),
  tool_response: z.unknown().optional(),
  tool_use_id: optStr,
  duration_ms: optNum,
  error: z.unknown().optional(),
  is_interrupt: optBool,
  // TaskCreated / TaskCompleted
  task_id: z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .optional()
    .catch(undefined),
  task_subject: optStr,
  task_description: optStr,
});

/** 与 zod 推断出的类型一致；Hook 路径使用 input.ts 中不依赖 zod 的实现。 */
export type { HookInput, HookEventName } from './input.js';
export { HOOK_EVENTS, parseHookInput } from './input.js';
