import { afterEach, describe, expect, it } from 'vitest';
import { renderPeriodSummary, renderToday } from '../src/cli/render.js';
import { categoryLabel } from '../src/core/commands.js';
import { formatDuration } from '../src/core/format.js';
import { todayRange, weekdayLabel } from '../src/core/time.js';
import { getLang, L, resetLang, setLang } from '../src/i18n.js';
import { buildWeeklyReport } from '../src/report/weekly.js';
import { collectPeriodStats } from '../src/stats/queries.js';
import { memoryDb, send, testConfig } from './helpers.js';

describe('输出语言', () => {
  afterEach(() => resetLang());

  it('默认中文；显式指定的语言不会被配置覆盖', () => {
    expect(getLang()).toBe('zh');
    expect(L('中', 'en')).toBe('中');
    setLang('en');
    expect(L('中', 'en')).toBe('en');
    setLang('zh', true);
    setLang('en');
    expect(getLang()).toBe('zh');
  });

  it('时长、星期、命令类别', () => {
    setLang('en');
    expect(formatDuration(3725)).toBe('1h 2m');
    expect(formatDuration(7200)).toBe('2h');
    expect(formatDuration(45)).toBe('<1m');
    expect(formatDuration(0)).toBe('0m');
    expect(weekdayLabel(new Date(2026, 8, 25))).toBe('Fri');
    expect(todayRange(new Date(2026, 8, 25, 12)).label).toBe('2026-09-25 (Fri)');
    expect(categoryLabel('install')).toBe('Install');
    resetLang();
    expect(formatDuration(3725)).toBe('1小时2分钟');
    expect(categoryLabel('install')).toBe('依赖安装');
  });

  it('终端输出与周报不含中文', () => {
    const db = memoryDb();
    const config = testConfig((c) => (c.collect.git = false));
    const cwd = process.cwd();
    const t = (m: number) => new Date(2026, 8, 24, 10, m);
    send(db, config, { session_id: 's', hook_event_name: 'SessionStart', cwd }, t(0));
    send(db, config, { session_id: 's', hook_event_name: 'PostToolUse', cwd, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: {} }, t(5));
    send(db, config, { session_id: 's', hook_event_name: 'PostToolUseFailure', cwd, tool_name: 'Bash', tool_input: { command: 'npm run build' }, error: 'Exit code 1' }, t(6));
    send(db, config, { session_id: 's', hook_event_name: 'SessionEnd', cwd, reason: 'other' }, t(10));
    setLang('en');
    const range = { start: new Date(2026, 8, 21), end: new Date(2026, 8, 28), label: '2026-W39' };
    const stats = collectPeriodStats(db, range, { idleMinutes: 30 });
    db.close();
    const han = /[一-鿿]/;
    const today = renderToday(stats);
    expect(today).toContain('Active time');
    const week = renderPeriodSummary(stats, 'This week', false);
    const report = buildWeeklyReport(stats, { generatedAt: new Date(2026, 8, 25) });
    expect(report).toContain('# DevTrack Weekly Report · 2026-W39');
    expect(report).toContain('## 6. Technical issues');
    expect(buildWeeklyReport(stats, { generatedAt: new Date(), period: 'month' })).toContain('Monthly Report');
    for (const text of [today, week, report]) expect(text).not.toMatch(han);
  });
});
