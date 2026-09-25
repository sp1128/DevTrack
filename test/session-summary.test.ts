import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderToday } from '../src/cli/render.js';
import type { DB } from '../src/db/database.js';
import { buildAiPayload, type AnthropicLike } from '../src/report/ai.js';
import {
  buildSessionPayload,
  cleanSummary,
  findSessionsToSummarize,
  resolveSummaryModel,
  summarizeSession,
} from '../src/report/sessionSummary.js';
import { buildWeeklyReport } from '../src/report/weekly.js';
import { collectPeriodStats } from '../src/stats/queries.js';
import { makeTempDir, memoryDb, rmrf, rows, send, testConfig } from './helpers.js';

function fakeAnthropic(text: string) {
  const calls: Record<string, unknown>[] = [];
  const client: AnthropicLike = {
    beta: {
      messages: {
        create: async (params) => {
          calls.push(params);
          return { stop_reason: 'end_turn', model: String(params.model), content: [{ type: 'text', text }] };
        },
      },
    },
  };
  return { calls, deps: { env: { ANTHROPIC_API_KEY: 'sk-test' }, createAnthropic: async () => client } };
}

describe('会话 AI 摘要', () => {
  let dir: string;
  let db: DB;
  const config = testConfig((c) => (c.collect.git = false));
  const cwd = () => path.join(dir, 'shop');
  const sessionIdOf = (external: string) =>
    rows<{ id: number }>(db, 'SELECT id FROM sessions WHERE session_id = ?', external)[0]!.id;

  beforeEach(() => {
    dir = makeTempDir();
    fs.mkdirSync(cwd());
    db = memoryDb();
    const at = (min: number) => new Date(Date.parse('2026-09-25T09:00:00Z') + min * 60_000);
    send(db, config, { session_id: 'work', hook_event_name: 'SessionStart', cwd: cwd() }, at(0));
    send(db, config, { session_id: 'work', hook_event_name: 'UserPromptSubmit', cwd: cwd(), prompt: '不会发送' }, at(1));
    send(
      db,
      config,
      {
        session_id: 'work',
        hook_event_name: 'PostToolUse',
        cwd: cwd(),
        tool_name: 'Write',
        tool_input: { file_path: path.join(cwd(), 'src/cart.ts'), content: 'export const secretCode = 1;' },
        tool_response: { type: 'create' },
      },
      at(5),
    );
    send(
      db,
      config,
      {
        session_id: 'work',
        hook_event_name: 'PostToolUse',
        cwd: cwd(),
        tool_name: 'Bash',
        tool_input: { command: 'npm test -- --token=abc123' },
        tool_response: {},
      },
      at(10),
    );
    send(db, config, { session_id: 'work', hook_event_name: 'SessionEnd', cwd: cwd(), reason: 'other' }, at(20));
    // 没有任何实际活动的会话
    send(db, config, { session_id: 'empty', hook_event_name: 'SessionStart', cwd: cwd() }, at(30));
    send(db, config, { session_id: 'empty', hook_event_name: 'SessionEnd', cwd: cwd(), reason: 'other' }, at(31));
    // 仍在进行中的会话
    send(db, config, { session_id: 'running', hook_event_name: 'SessionStart', cwd: cwd() }, at(40));
  });

  afterEach(() => {
    db.close();
    rmrf(dir);
  });

  it('只发送统计数据：不含提示词、源代码、命令原文，默认不含文件路径', () => {
    const payload = buildSessionPayload(db, sessionIdOf('work'), config)!;
    expect(payload).toMatchObject({ project: 'shop', prompts: 1, activeMinutes: 20, files: { modified: 1, created: 1 } });
    expect(payload.commands).toEqual([{ category: 'test', total: 1, failed: 0 }]);
    const text = JSON.stringify(payload);
    for (const secret of ['不会发送', 'secretCode', 'abc123', 'npm test', 'cart.ts']) expect(text).not.toContain(secret);

    const withPaths = buildSessionPayload(db, sessionIdOf('work'), testConfig((c) => (c.ai.includeFilePaths = true)));
    expect(JSON.stringify(withPaths)).toContain('src/cart.ts');
    expect(buildSessionPayload(db, sessionIdOf('empty'), config)).toBeNull();
  });

  it('只处理已结束、没有摘要的会话', () => {
    const since = new Date('2026-09-01T00:00:00Z');
    expect(findSessionsToSummarize(db, { since }).map((s) => s.sessionId)).toEqual(['empty', 'work']);
    expect(findSessionsToSummarize(db, { since, sessionId: 'work' }).map((s) => s.sessionId)).toEqual(['work']);
    expect(findSessionsToSummarize(db, { since: new Date('2026-09-26T00:00:00Z') })).toEqual([]);
    db.prepare("UPDATE sessions SET summary = 'x' WHERE session_id = 'work'").run();
    expect(findSessionsToSummarize(db, { since }).map((s) => s.sessionId)).toEqual(['empty']);
    expect(findSessionsToSummarize(db, { since, force: true }).map((s) => s.sessionId)).toEqual(['empty', 'work']);
  });

  it('生成并保存摘要：默认用 Haiku，结果整理为单行并脱敏', async () => {
    // 虚构的令牌，拼接前缀以免被 GitHub 密钥扫描误报
    const { calls, deps } = fakeAnthropic(`摘要：“为 shop 新增购物车模块并运行测试，API_KEY=${'sk-ant-'}abcdefghijklmnopqrstuvwxyz”\n\n补充说明`);
    const now = new Date('2026-09-25T10:00:00Z');
    const result = await summarizeSession(db, sessionIdOf('work'), config, now, deps);
    expect(calls[0]!.model).toBe('claude-haiku-4-5');
    expect(calls[0]!.max_tokens).toBe(1024);
    expect(String((calls[0]!.messages as { content: string }[])[0]!.content)).toContain('"project": "shop"');
    expect(result!.summary).toBe('为 shop 新增购物车模块并运行测试，API_KEY=[REDACTED]');
    expect(rows(db, "SELECT summary, summarized_at FROM sessions WHERE session_id = 'work'")).toEqual([
      { summary: result!.summary, summarized_at: now.toISOString() },
    ]);
    // 没有活动的会话不调用 AI
    expect(await summarizeSession(db, sessionIdOf('empty'), config, now, deps)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('模型选择：sessionSummaryModel 优先，其次按提供商默认', () => {
    expect(resolveSummaryModel(config)).toBe('claude-haiku-4-5');
    expect(resolveSummaryModel(testConfig((c) => (c.ai.sessionSummaryModel = 'claude-sonnet-5')))).toBe('claude-sonnet-5');
    expect(resolveSummaryModel(testConfig((c) => (c.ai.provider = 'deepseek')))).toBe('deepseek-chat');
    expect(() => resolveSummaryModel(testConfig((c) => (c.ai.provider = 'openai')))).toThrow(/ai.model/);
  });

  it('cleanSummary 处理常见格式', () => {
    expect(cleanSummary('\n\n## 修复登录问题\n更多')).toBe('修复登录问题');
    expect(cleanSummary('"重构数据库层"')).toBe('重构数据库层');
    expect(cleanSummary('- 总结: 完善文档'.replace('总结: ', '总结：'))).toBe('完善文档');
    expect(cleanSummary('x'.repeat(500)).length).toBeLessThanOrEqual(200);
    expect(cleanSummary('```\ncode\n```')).toBe('');
  });

  it('摘要显示在终端、周报与 AI 周报数据中', async () => {
    const { deps } = fakeAnthropic('为 shop 新增购物车模块');
    await summarizeSession(db, sessionIdOf('work'), config, new Date('2026-09-25T10:00:00Z'), deps);
    const range = { start: new Date('2026-09-21T00:00:00Z'), end: new Date('2026-09-28T00:00:00Z'), label: '2026-W39' };
    const stats = collectPeriodStats(db, range, { idleMinutes: 30 });
    expect(stats.sessions.find((s) => s.sessionId === 'work')!.summary).toBe('为 shop 新增购物车模块');
    expect(renderToday(stats)).toContain('为 shop 新增购物车模块');
    expect(buildWeeklyReport(stats, { generatedAt: new Date() })).toContain('会话摘要');
    expect(JSON.stringify(buildAiPayload(stats, config))).toContain('"summary":"为 shop 新增购物车模块"');
  });
});
