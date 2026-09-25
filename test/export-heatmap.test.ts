import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csvCell, exportRows, runExport, toCsv, EXPORT_TYPES } from '../src/cli/commands/export.js';
import { computeLevels, renderHeatmap, streaks } from '../src/cli/commands/heatmap.js';
import { stripAnsi } from '../src/cli/format.js';
import type { DB } from '../src/db/database.js';
import type { DailySummary } from '../src/stats/queries.js';
import { collectPeriodStats } from '../src/stats/queries.js';
import { isolateEnv, makeTempDir, memoryDb, rmrf, send, testConfig } from './helpers.js';

describe('CSV', () => {
  it('按 RFC 4180 转义，并防止公式注入', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+cmd')).toBe("'+cmd");
    expect(csvCell('-rf')).toBe("'-rf");
    expect(csvCell('-12.5')).toBe('-12.5');
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell(null)).toBe('');
    expect(csvCell(true)).toBe('true');
    expect(toCsv([{ a: 1, b: 'x' }, { a: 2, b: null }])).toBe('a,b\r\n1,x\r\n2,\r\n');
    expect(toCsv([], ['a', 'b'])).toBe('a,b\r\n');
  });
});

describe('导出', () => {
  let dir: string;
  let db: DB;
  const config = testConfig((c) => {
    c.collect.git = false;
    c.collect.tokenUsage = true;
  });
  const range = { start: new Date('2026-09-21T00:00:00Z'), end: new Date('2026-09-28T00:00:00Z'), label: 'w' };

  beforeEach(() => {
    dir = makeTempDir();
    const cwd = path.join(dir, 'app');
    fs.mkdirSync(cwd);
    db = memoryDb();
    const t = (min: number) => new Date(Date.parse('2026-09-24T09:00:00Z') + min * 60_000);
    send(db, config, { session_id: 's1', hook_event_name: 'SessionStart', cwd }, t(0));
    send(db, config, { session_id: 's1', hook_event_name: 'PostToolUse', cwd, tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'a.ts') }, tool_response: { type: 'create' } }, t(1));
    send(db, config, { session_id: 's1', hook_event_name: 'PostToolUse', cwd, tool_name: 'Bash', tool_input: { command: 'API_KEY=secret npm test' }, tool_response: {} }, t(2));
    send(db, config, { session_id: 's1', hook_event_name: 'TaskCompleted', cwd, task_id: '1', task_subject: '实现导出' }, t(3));
    db.prepare(
      `INSERT INTO token_usage (session_id, project_id, message_id, model, timestamp, input_tokens, output_tokens)
       VALUES (1, 1, 'm1', 'claude-opus-5-5', ?, 1000000, 0)`,
    ).run(t(4).toISOString());
    send(db, config, { session_id: 's1', hook_event_name: 'SessionEnd', cwd, reason: 'other' }, t(10));
  });

  afterEach(() => {
    db.close();
    rmrf(dir);
  });

  it('各类型都能导出，命令已脱敏', () => {
    const stats = collectPeriodStats(db, range, { idleMinutes: 30 });
    const get = (type: (typeof EXPORT_TYPES)[number]) => exportRows(db, stats, type, range, config);
    expect(get('sessions')).toEqual([expect.objectContaining({ session_id: 's1', project: 'app', active_minutes: 10 })]);
    expect(get('daily')).toHaveLength(7);
    expect(get('projects')[0]).toMatchObject({ project: 'app', sessions: 1, files: 1, tokens: 1_000_000, cost_usd: 4 });
    expect(get('files')).toEqual([expect.objectContaining({ file_path: 'a.ts', action: 'create', session_id: 's1' })]);
    const commands = get('commands');
    expect(commands).toHaveLength(1);
    expect(commands[0]!.command).toBe('API_KEY=[REDACTED] npm test');
    expect(get('tasks')).toEqual([expect.objectContaining({ title: '实现导出', status: 'completed' })]);
    expect(get('tokens')).toEqual([expect.objectContaining({ model: 'claude-opus-5-5', input_tokens: 1_000_000, cost_usd: 4 })]);
    expect(get('commits')).toEqual([]);
  });
});

describe('export 命令', () => {
  let env: ReturnType<typeof isolateEnv>;
  let stdout = '';
  beforeEach(() => {
    env = isolateEnv();
    stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    env.restore();
  });

  it('CSV 写入文件时带 BOM；JSON 默认导出全部类型；参数校验', async () => {
    const file = path.join(env.home, 'out', 'sessions.csv');
    await runExport({ output: file, sync: false });
    const content = fs.readFileSync(file, 'utf8');
    expect(content.startsWith('﻿session_id,project,')).toBe(true);

    await runExport({ format: 'json', sync: false });
    expect(Object.keys(JSON.parse(stdout))).toEqual(['range', ...EXPORT_TYPES]);

    await expect(runExport({ format: 'xml', sync: false })).rejects.toThrow(/csv \/ json/);
    await expect(runExport({ type: 'secrets', sync: false })).rejects.toThrow(/--type/);
    await expect(runExport({ since: 'yesterday', sync: false })).rejects.toThrow(/无法识别/);
  });
});

describe('热力图', () => {
  it('按第 90 百分位分级，有活动的天至少 1 级', () => {
    expect(computeLevels([0, 0])).toEqual([0, 0]);
    expect(computeLevels([5, 5, 5])).toEqual([4, 4, 4]);
    const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1000];
    const levels = computeLevels(values);
    expect(levels[0]).toBe(0);
    expect(levels[1]).toBe(1);
    expect(levels[11]).toBe(4);
    expect(levels[5]).toBe(2);
  });

  it('连续活跃天数', () => {
    expect(streaks([true, true, false, true, true, true])).toEqual({ longest: 3, current: 3 });
    // 今天还没有活动时，当前连续从昨天算起
    expect(streaks([true, true, true, false])).toEqual({ longest: 3, current: 3 });
    expect(streaks([true, false, false])).toEqual({ longest: 1, current: 0 });
  });

  it('7 行 × N 周，今天之后留空', () => {
    process.env.NO_COLOR = '1';
    try {
      const daily: DailySummary[] = [];
      const start = new Date(2026, 7, 31); // 周一
      for (let i = 0; i < 28; i++) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        daily.push({ date, activeSeconds: i % 2 === 0 ? 3600 : 0, sessions: 0, commits: 0, fileEdits: 0, commands: 0, tokens: 0, cost: null });
      }
      const out = stripAnsi(renderHeatmap(daily, 'time', '2026-09-24'));
      const lines = out.split('\n');
      // 9 月的标签会与 8 月重叠，因此省略
      expect(lines[0]).toBe('    8月');
      // 隔天有活动：第 0、2、4… 天
      expect(lines[1]).toBe('一  █ · █ ·');
      expect(lines[2]).toBe('    · █ · █');
      // 2026-09-24 是周四：最后一周的周五到周日留空
      expect(lines[4]).toBe('    · █ · █');
      expect(lines[5]).toBe('五  █ · █');
      expect(lines[7]).toBe('日  █ · █');
      expect(out).toContain('少 · ░ ▒ ▓ █ 多');
      expect(out).toContain('开发时长 13小时 · 活跃 13 天 · 最长连续 1 天');
    } finally {
      delete process.env.NO_COLOR;
    }
  });
});
