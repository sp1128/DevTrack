import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema, defaultConfig } from '../src/config.js';
import { loadConfigFast, parseConfigLite } from '../src/configLite.js';
import { parseHookInput } from '../src/hooks/input.js';
import { HookInputSchema } from '../src/hooks/schema.js';
import { makeTempDir, rmrf } from './helpers.js';

/** 轻量解析要么与 zod 结果完全相同，要么返回 null（退回 zod）；zod 报错时轻量解析必须返回 null。 */
function expectConfigEquivalent(raw: unknown) {
  const lite = parseConfigLite(raw);
  const full = ConfigSchema.safeParse(raw);
  if (!full.success) {
    expect(lite, JSON.stringify(raw)).toBeNull();
  } else if (lite !== null) {
    expect(lite, JSON.stringify(raw)).toEqual(full.data);
  }
  return lite;
}

describe('Hook 轻量配置解析与 zod 等价', () => {
  it('默认值一致', () => {
    expect(parseConfigLite({})).toEqual(defaultConfig());
  });

  it('常见配置直接解析', () => {
    const cases: unknown[] = [
      { enabled: false },
      { lang: 'en', collect: { commands: false, tokenUsage: true } },
      { privacy: { redactPatterns: ['foo\\d+'], excludeProjects: ['secret', '/work/x'] } },
      { commands: { ignore: [], maxLength: 40 } },
      { git: { authorOnly: false, authorEmails: ['me@a.com'], backfillDays: 0, trackWorkingTree: false } },
      { retention: { days: 0 }, activity: { idleMinutes: 480 }, report: { autoWeekly: false, autoAi: true } },
      { ai: { provider: 'deepseek', model: 'x', baseUrl: 'http://h', apiKeyEnv: 'K', sessionSummary: true, sessionSummaryModel: 'm' } },
      { usage: { prices: {} } },
      { version: 1, unknownKey: 1, collect: { unknown: true } },
      JSON.parse(JSON.stringify(defaultConfig())),
    ];
    for (const raw of cases) expect(expectConfigEquivalent(raw), JSON.stringify(raw)).not.toBeNull();
  });

  it('非法或复杂配置退回 zod', () => {
    const cases: unknown[] = [
      null,
      [],
      'x',
      { version: 2 },
      { enabled: 'yes' },
      { lang: 'fr' },
      { collect: null },
      { collect: [] },
      { collect: { git: 1 } },
      { privacy: { redactPatterns: [1] } },
      { commands: { maxLength: 39 } },
      { commands: { maxLength: 4001 } },
      { commands: { maxLength: 300.5 } },
      { git: { authorEmails: ['ab'] } },
      { git: { backfillDays: -1 } },
      { retention: { days: 3651 } },
      { activity: { idleMinutes: 0 } },
      { ai: { provider: 'gemini' } },
      { ai: { model: '' } },
      { ai: { timeoutSeconds: 4 } },
      { usage: { prices: { m: { input: 1, output: 2 } } } },
      { usage: { prices: { m: { input: -1 } } } },
      { report: { autoWeekly: 'false' } },
    ];
    for (const raw of cases) expect(expectConfigEquivalent(raw), JSON.stringify(raw)).toBeNull();
  });

  it('读取文件：不存在时返回默认配置，JSON 错误时返回 null', () => {
    const dir = makeTempDir();
    try {
      const file = path.join(dir, 'config.json');
      expect(loadConfigFast(file)).toEqual(defaultConfig());
      fs.writeFileSync(file, '{"enabled": false}');
      expect(loadConfigFast(file)?.enabled).toBe(false);
      fs.writeFileSync(file, '{broken');
      expect(loadConfigFast(file)).toBeNull();
    } finally {
      rmrf(dir);
    }
  });
});

describe('Hook 输入手写校验与 zod 等价', () => {
  const cases: unknown[] = [
    { session_id: 's', hook_event_name: 'SessionStart', cwd: '/p', source: 'startup', model: 'claude-x', extra: 1 },
    { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { a: 1 }, duration_ms: 12.5 },
    { session_id: 's', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: [], error: 'Exit code 1', is_interrupt: false },
    { session_id: 's', hook_event_name: 'PostToolUse', tool_input: null, tool_response: null, error: null },
    { session_id: 's', hook_event_name: 'TaskCreated', task_id: 7, task_subject: 'x', task_description: 3 },
    { session_id: 's', hook_event_name: 'TaskCompleted', task_id: 'abc' },
    { session_id: 's', hook_event_name: 'TaskCompleted', task_id: true },
    { session_id: 's', hook_event_name: 'Stop', cwd: 5, duration_ms: '5', is_interrupt: 'yes', transcript_path: '/t.jsonl' },
    { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: 'hello', permission_mode: 'default', agent_id: 'a', agent_type: 't' },
    { session_id: 's', hook_event_name: 'SessionEnd', reason: 'other', session_title: 'T', scratchpad_dir: '/s', tool_use_id: 'u' },
  ];

  it('合法输入的解析结果相同', () => {
    for (const payload of cases) {
      const fast = parseHookInput(payload);
      expect(fast.success).toBe(true);
      expect(fast.success && fast.data, JSON.stringify(payload)).toEqual(HookInputSchema.parse(payload));
    }
  });

  it('缺少必填字段时两者都失败', () => {
    for (const payload of [null, [], 'x', {}, { session_id: 's' }, { session_id: '', hook_event_name: 'Stop' }, { session_id: 1, hook_event_name: 'Stop' }]) {
      expect(parseHookInput(payload).success, JSON.stringify(payload)).toBe(false);
      expect(HookInputSchema.safeParse(payload).success, JSON.stringify(payload)).toBe(false);
    }
  });
});
