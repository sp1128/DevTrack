import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runReport } from '../src/cli/commands/report.js';
import { consumeAutoReportNotice } from '../src/cli/notice.js';
import { defaultConfig } from '../src/config.js';
import { monthRange, weekRange } from '../src/core/time.js';
import { openDatabase } from '../src/db/database.js';
import { currentWeekStart, maybeSpawnWeeklyReport } from '../src/hooks/spawn.js';
import { generateAiSummary, type AnthropicLike } from '../src/report/ai.js';
import { buildWeeklyReport } from '../src/report/weekly.js';
import { collectPeriodStats } from '../src/stats/queries.js';
import { getPaths } from '../src/paths.js';
import { isolateEnv, memoryDb, send, testConfig } from './helpers.js';

describe('月报', () => {
  it('月报使用"本月"措辞', () => {
    const db = memoryDb();
    const range = monthRange(new Date('2026-09-15T12:00:00'));
    const stats = collectPeriodStats(db, range, { idleMinutes: 30 });
    db.close();
    const md = buildWeeklyReport(stats, { generatedAt: new Date(), period: 'month' });
    expect(md).toContain('# DevTrack 开发月报 · 2026-09');
    expect(md).toContain('## 一、本月开发概况');
    expect(md).not.toContain('本周');
    expect(buildWeeklyReport(stats, { generatedAt: new Date() })).toContain('## 一、本周开发概况');
  });

  it('月报的 AI 提示词', async () => {
    const calls: Record<string, unknown>[] = [];
    const client: AnthropicLike = {
      beta: {
        messages: {
          create: async (params) => {
            calls.push(params);
            return { stop_reason: 'end_turn', model: 'm', content: [{ type: 'text', text: 'ok' }] };
          },
        },
      },
    };
    const db = memoryDb();
    const stats = collectPeriodStats(db, monthRange(new Date()), { idleMinutes: 30 });
    db.close();
    await generateAiSummary(stats, testConfig(), { env: { ANTHROPIC_API_KEY: 'k' }, createAnthropic: async () => client }, 'month');
    expect(String(calls[0]!.system)).toContain('月报');
    expect(String(calls[0]!.system)).toContain('下月建议');
    expect(String((calls[0]!.messages as { content: string }[])[0]!.content)).toContain('本月');
  });
});

describe('自动周报', () => {
  let env: ReturnType<typeof isolateEnv>;
  beforeEach(() => {
    env = isolateEnv();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    env.restore();
  });

  it('每周第一次会话触发一次', () => {
    const db = memoryDb();
    const calls: string[][] = [];
    const spawnFn = (args: string[]) => calls.push(args);
    const monday = new Date(2026, 8, 21, 9, 0);
    expect(currentWeekStart(new Date(2026, 8, 27, 23, 59))).toBe(new Date(2026, 8, 21).toISOString());
    expect(maybeSpawnWeeklyReport(db, monday, spawnFn)).toBe(true);
    expect(maybeSpawnWeeklyReport(db, new Date(2026, 8, 25, 18, 0), spawnFn)).toBe(false);
    expect(maybeSpawnWeeklyReport(db, new Date(2026, 8, 28, 8, 0), spawnFn)).toBe(true);
    expect(calls).toEqual([
      ['report', '--last', '--auto'],
      ['report', '--last', '--auto'],
    ]);
    db.close();
  });

  it('生成上周周报：不覆盖已有文件，没有数据时不生成，并在下次查看时提示一次', async () => {
    const paths = getPaths();
    const lastWeek = weekRange(new Date(), -1);
    const target = path.join(paths.reportsDir, `${lastWeek.label}.md`);

    // 上周没有数据：不生成
    await runReport({ auto: true, last: true, sync: false });
    expect(fs.existsSync(target)).toBe(false);

    const db = openDatabase(paths.dbFile);
    const config = defaultConfig();
    config.collect.git = false;
    const cwd = env.home;
    fs.mkdirSync(cwd, { recursive: true });
    const t = lastWeek.start.getTime() + 26 * 3600_000;
    send(db, config, { session_id: 'lw', hook_event_name: 'SessionStart', cwd }, new Date(t));
    send(db, config, { session_id: 'lw', hook_event_name: 'PostToolUse', cwd, tool_name: 'Read', tool_input: {} }, new Date(t + 60_000));
    send(db, config, { session_id: 'lw', hook_event_name: 'SessionEnd', cwd, reason: 'other' }, new Date(t + 120_000));
    db.close();

    await runReport({ auto: true, last: true, sync: false });
    expect(fs.readFileSync(target, 'utf8')).toContain(`# DevTrack 开发周报 · ${lastWeek.label}`);

    // 已有文件不覆盖
    fs.writeFileSync(target, '我的修改');
    await runReport({ auto: true, last: true, sync: false });
    expect(fs.readFileSync(target, 'utf8')).toBe('我的修改');

    const db2 = openDatabase(paths.dbFile);
    expect(consumeAutoReportNotice(db2)).toContain(`${lastWeek.label}.md`);
    expect(consumeAutoReportNotice(db2)).toBe('');
    db2.close();
  });

  it('report --month 生成月报文件', async () => {
    await runReport({ month: true, sync: false });
    const label = monthRange(new Date()).label;
    const file = path.join(getPaths().reportsDir, `${label}.md`);
    expect(fs.readFileSync(file, 'utf8')).toContain(`# DevTrack 开发月报 · ${label}`);
    await runReport({ month: '2026-01', sync: false });
    expect(fs.existsSync(path.join(getPaths().reportsDir, '2026-01.md'))).toBe(true);
    await expect(runReport({ month: '2026-13', sync: false })).rejects.toThrow(/YYYY-MM/);
    await expect(runReport({ month: true, week: '2026-W01', sync: false })).rejects.toThrow(/不能同时使用/);
  });
});
