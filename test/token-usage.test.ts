import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { estimateCost, findPrice } from '../src/core/pricing.js';
import { ingestTranscript, parseUsageLine } from '../src/core/transcript.js';
import type { DB } from '../src/db/database.js';
import { purgeBefore } from '../src/db/purge.js';
import { renderToday } from '../src/cli/render.js';
import { buildWeeklyReport } from '../src/report/weekly.js';
import { buildAiPayload } from '../src/report/ai.js';
import { collectPeriodStats } from '../src/stats/queries.js';
import { makeTempDir, memoryDb, rmrf, rows, send, testConfig } from './helpers.js';

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

function assistant(id: string, ts: string, usage: Record<string, unknown>, model = 'claude-opus-5-5', content = 'ok'): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { id, model, role: 'assistant', content: [{ type: 'text', text: content }], usage },
  });
}

function user(text: string, ts: string): string {
  return JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
}

describe('模型价格', () => {
  it('按模型名匹配价格，带日期后缀的模型名也能匹配', () => {
    expect(findPrice('claude-opus-5-5')).toEqual({ input: 4, output: 20, cacheRead: 0.2 });
    expect(findPrice('claude-haiku-4-5-20251001')?.input).toBe(1);
    // claude-opus-5 不能误匹配 claude-opus-5-5
    expect(findPrice('claude-opus-5')?.input).toBe(5);
    expect(findPrice('claude-opus-5-9')).toBeNull();
    expect(findPrice('gpt-5')).toBeNull();
    expect(findPrice(null)).toBeNull();
  });

  it('费用计算与 Claude Code 自己的计算一致', () => {
    // Opus 5.5：$4 输入 / $20 输出 / $0.2 缓存读取；1 小时缓存写入按输入的 2 倍
    const cost = estimateCost('claude-opus-5-5', {
      input: 1_000_000,
      output: 100_000,
      cacheRead: 10_000_000,
      cacheWrite5m: 1_000_000,
      cacheWrite1h: 1_000_000,
    });
    expect(cost).toBeCloseTo(4 + 2 + 2 + 5 + 8, 6);
    // 未指定缓存读取价格时按输入价格的 0.1 倍
    expect(estimateCost('claude-opus-5', { ...zero, cacheRead: 1_000_000 })).toBeCloseTo(0.5, 6);
    expect(estimateCost('unknown-model', { ...zero, input: 100 })).toBeNull();
  });

  it('usage.prices 可以补充或覆盖价格', () => {
    const overrides = { 'my-model': { input: 1, output: 2 }, 'claude-opus-5-5': { input: 100, output: 100 } };
    expect(estimateCost('my-model', { ...zero, output: 1_000_000 }, overrides)).toBeCloseTo(2, 6);
    expect(estimateCost('claude-opus-5-5', { ...zero, input: 1_000_000 }, overrides)).toBeCloseTo(100, 6);
  });
});

describe('解析会话记录', () => {
  it('只读取助手消息的 usage，区分 5 分钟与 1 小时缓存', () => {
    const r = parseUsageLine(
      assistant('msg_1', '2026-09-25T10:00:00Z', {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
        cache_creation: { ephemeral_5m_input_tokens: 15, ephemeral_1h_input_tokens: 25 },
      }),
    );
    expect(r).toEqual({
      messageId: 'msg_1',
      model: 'claude-opus-5-5',
      timestamp: '2026-09-25T10:00:00.000Z',
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite5m: 15,
      cacheWrite1h: 25,
    });
    // 没有 cache_creation 拆分时按 5 分钟缓存计算
    expect(parseUsageLine(assistant('m', '2026-09-25T10:00:00Z', { cache_creation_input_tokens: 7 }))?.cacheWrite5m).toBe(7);
    expect(parseUsageLine(user('"assistant" "usage"', '2026-09-25T10:00:00Z'))).toBeNull();
    expect(parseUsageLine('{"type":"assistant","usage":')).toBeNull();
    expect(parseUsageLine(JSON.stringify({ type: 'assistant', timestamp: 'x', message: { id: 'a', usage: {} } }))).toBeNull();
  });
});

describe('导入 Token 用量', () => {
  let dir: string;
  let db: DB;
  let transcript: string;
  const cwd = () => path.join(dir, 'proj');
  const now = new Date('2026-09-25T12:00:00Z');
  const config = testConfig((c) => {
    c.collect.git = false;
    c.collect.tokenUsage = true;
  });

  beforeEach(() => {
    dir = makeTempDir();
    fs.mkdirSync(cwd());
    db = memoryDb();
    transcript = path.join(dir, 'claude', 'projects', 'proj', 'sess-1.jsonl');
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    send(db, config, { session_id: 'sess-1', hook_event_name: 'SessionStart', cwd: cwd(), transcript_path: transcript }, new Date('2026-09-25T09:59:00Z'));
  });

  afterEach(() => {
    db.close();
    rmrf(dir);
  });

  const stop = (at: string, extra: Record<string, unknown> = {}) =>
    send(db, config, { session_id: 'sess-1', hook_event_name: 'Stop', cwd: cwd(), transcript_path: transcript, ...extra }, new Date(at));

  it('Stop 时增量读取，按 message.id 去重，不保存对话内容', () => {
    const usage = { input_tokens: 100, output_tokens: 1000, cache_read_input_tokens: 5000 };
    fs.writeFileSync(
      transcript,
      [
        user('我的密码是 hunter2-secret', '2026-09-25T10:00:00Z'),
        // 同一次 API 响应拆成多行记录
        assistant('msg_a', '2026-09-25T10:00:05Z', usage, 'claude-opus-5-5', 'thinking'),
        assistant('msg_a', '2026-09-25T10:00:06Z', usage, 'claude-opus-5-5', 'hunter2-secret'),
        assistant('msg_b', '2026-09-25T10:01:00Z', { input_tokens: 1, output_tokens: 2 }, 'claude-haiku-4-5-20251001'),
      ].join('\n') + '\n',
    );
    stop('2026-09-25T10:02:00Z');
    expect(rows(db, 'SELECT message_id FROM token_usage ORDER BY message_id')).toEqual([{ message_id: 'msg_a' }, { message_id: 'msg_b' }]);
    const dump = JSON.stringify(rows(db, 'SELECT * FROM token_usage')) + JSON.stringify(rows(db, 'SELECT * FROM events'));
    expect(dump).not.toContain('hunter2');

    // 追加内容：只读取新增部分；末尾不完整的一行留到下次
    const partial = assistant('msg_c', '2026-09-25T10:03:00Z', { input_tokens: 3, output_tokens: 4 });
    fs.appendFileSync(transcript, partial.slice(0, 20));
    stop('2026-09-25T10:03:30Z');
    expect(rows(db, 'SELECT * FROM token_usage')).toHaveLength(2);
    fs.appendFileSync(transcript, partial.slice(20) + '\n');
    stop('2026-09-25T10:04:00Z');
    expect(rows(db, 'SELECT * FROM token_usage')).toHaveLength(3);

    // 重复导入不会重复计数
    db.prepare('DELETE FROM transcript_offsets').run();
    stop('2026-09-25T10:05:00Z');
    expect(rows(db, 'SELECT * FROM token_usage')).toHaveLength(3);
  });

  it('同时读取子代理的会话记录', () => {
    fs.writeFileSync(transcript, assistant('main', '2026-09-25T10:00:00Z', { output_tokens: 10 }) + '\n');
    const sub = path.join(path.dirname(transcript), 'sess-1', 'subagents', 'agent-x.jsonl');
    fs.mkdirSync(path.dirname(sub), { recursive: true });
    fs.writeFileSync(sub, assistant('sub', '2026-09-25T10:00:30Z', { output_tokens: 20 }, 'claude-haiku-4-5') + '\n');
    send(db, config, { session_id: 'sess-1', hook_event_name: 'SessionEnd', cwd: cwd(), transcript_path: transcript, reason: 'other' }, new Date('2026-09-25T10:01:00Z'));
    expect(rows<{ model: string }>(db, 'SELECT model FROM token_usage ORDER BY id').map((r) => r.model)).toEqual([
      'claude-opus-5-5',
      'claude-haiku-4-5',
    ]);
  });

  it('默认关闭；文件不存在或不是 jsonl 时忽略', () => {
    fs.writeFileSync(transcript, assistant('m1', '2026-09-25T10:00:00Z', { output_tokens: 10 }) + '\n');
    send(db, testConfig((c) => (c.collect.git = false)), { session_id: 'sess-1', hook_event_name: 'Stop', cwd: cwd(), transcript_path: transcript }, new Date('2026-09-25T10:01:00Z'));
    expect(rows(db, 'SELECT * FROM token_usage')).toHaveLength(0);
    expect(stop('2026-09-25T10:02:00Z', { transcript_path: path.join(dir, 'missing.jsonl') }).status).toBe('recorded');
    expect(stop('2026-09-25T10:03:00Z', { transcript_path: path.join(dir, 'proj') }).status).toBe('recorded');
    expect(rows(db, 'SELECT * FROM token_usage')).toHaveLength(0);
  });

  it('统计、终端输出、周报与 AI 数据中包含 Token 用量与估算费用', () => {
    fs.writeFileSync(
      transcript,
      [
        assistant('a', '2026-09-25T10:00:00Z', { input_tokens: 1_000_000, output_tokens: 100_000 }),
        assistant('b', '2026-09-25T10:10:00Z', { output_tokens: 500 }, 'some-custom-model'),
      ].join('\n') + '\n',
    );
    stop('2026-09-25T10:11:00Z');
    const range = { start: new Date('2026-09-21T00:00:00Z'), end: new Date('2026-09-28T00:00:00Z'), label: '2026-W39' };
    const stats = collectPeriodStats(db, range, { idleMinutes: 30 });
    expect(stats.tokens).toMatchObject({ messages: 2, input: 1_000_000, output: 100_500, total: 1_100_500, unpricedTokens: 500 });
    expect(stats.tokens!.cost).toBeCloseTo(6, 6);
    expect(stats.tokens!.byModel.map((m) => m.model)).toEqual(['claude-opus-5-5', 'some-custom-model']);
    expect(stats.projects[0]!.tokens).toBe(1_100_500);
    expect(stats.daily.reduce((n, d) => n + d.tokens, 0)).toBe(1_100_500);

    const priced = collectPeriodStats(db, range, { idleMinutes: 30, prices: { 'some-custom-model': { input: 0, output: 10 } } });
    expect(priced.tokens!.cost).toBeCloseTo(6.005, 6);
    expect(priced.tokens!.unpricedTokens).toBe(0);

    expect(renderToday(stats)).toContain('$6.00');
    const report = buildWeeklyReport(stats, { generatedAt: now });
    expect(report).toContain('### Token 用量');
    expect(report).toContain('价格未知');
    expect(JSON.stringify(buildAiPayload(stats, config))).toContain('"estimatedCostUSD":6');
  });

  it('没有 Token 记录时不显示', () => {
    const range = { start: new Date('2026-09-21T00:00:00Z'), end: new Date('2026-09-28T00:00:00Z'), label: '2026-W39' };
    const stats = collectPeriodStats(db, range, { idleMinutes: 30 });
    expect(stats.tokens).toBeNull();
    expect(renderToday(stats)).not.toContain('Token');
    expect(buildWeeklyReport(stats, { generatedAt: now })).not.toContain('Token');
  });

  it('过期的 Token 记录会被清理', () => {
    fs.writeFileSync(transcript, assistant('old', '2025-01-01T00:00:00Z', { output_tokens: 1 }) + '\n' + assistant('new', '2026-09-25T10:00:00Z', { output_tokens: 1 }) + '\n');
    stop('2026-09-25T10:01:00Z');
    purgeBefore(db, new Date(now.getTime() - 180 * 24 * 3600 * 1000), now);
    expect(rows(db, 'SELECT message_id FROM token_usage')).toEqual([{ message_id: 'new' }]);
  });
});
