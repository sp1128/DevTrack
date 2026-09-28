import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportRows } from '../src/cli/commands/export.js';
import { renderToday } from '../src/cli/render.js';
import { DEFAULT_TICKET_OPTIONS, extractTickets } from '../src/core/tickets.js';
import type { DB } from '../src/db/database.js';
import { buildWeeklyReport } from '../src/report/weekly.js';
import { collectPeriodStats } from '../src/stats/queries.js';
import { commitFile, createRepo, git, makeTempDir, memoryDb, rmrf, send, testConfig } from './helpers.js';

describe('工单号提取', () => {
  it('默认识别大写前缀-数字，并忽略 UTF-8 等常见误报', () => {
    expect(extractTickets('feature/AUTH-42-refresh-token')).toEqual(['AUTH-42']);
    expect(extractTickets('fix: AUTH-42 与 PAY-7 的回调，AUTH-42 再次出现')).toEqual(['AUTH-42', 'PAY-7']);
    expect(extractTickets('chore: switch to UTF-8 and SHA-256, see RFC-9110')).toEqual([]);
    expect(extractTickets('claude/intelligent-clarke-6krwb8')).toEqual([]);
    expect(extractTickets('release-2')).toEqual([]);
    expect(extractTickets(null)).toEqual([]);
  });

  it('自定义规则：忽略大小写、捕获组、非法正则', () => {
    const lower = { ...DEFAULT_TICKET_OPTIONS, ignoreCase: true };
    expect(extractTickets('feature/auth-42-login', lower)).toEqual(['AUTH-42']);
    const github = { ...DEFAULT_TICKET_OPTIONS, patterns: ['(#\\d+)', '(?:^|/)issue-(\\d+)', '('] };
    expect(extractTickets('fix: login (#123)', github)).toEqual(['#123']);
    expect(extractTickets('bugfix/issue-88-crash', github)).toEqual(['88']);
  });
});

describe('按工单统计', () => {
  let dir: string;
  let db: DB;
  let repo: string;
  const config = testConfig();

  beforeEach(() => {
    dir = makeTempDir();
    repo = createRepo(path.join(dir, 'shop'));
    git(repo, ['switch', '-q', '-c', 'feature/AUTH-42-login']);
    db = memoryDb();
  });
  afterEach(() => {
    db.close();
    rmrf(dir);
  });

  it('会话按分支、提交按分支与说明归入工单', () => {
    const t0 = Date.now() - 20 * 60_000;
    const at = (min: number) => new Date(t0 + min * 60_000);
    send(db, config, { session_id: 's1', hook_event_name: 'SessionStart', cwd: repo }, at(0));
    send(db, config, { session_id: 's1', hook_event_name: 'PostToolUse', cwd: repo, tool_name: 'Read', tool_input: {} }, at(10));
    commitFile(repo, 'a.ts', 'a', 'feat: 登录页');
    commitFile(repo, 'b.ts', 'b', 'fix: 顺手修复 PAY-7 的金额显示');
    fs.writeFileSync(path.join(repo, 'c.ts'), 'c');
    send(db, config, { session_id: 's1', hook_event_name: 'SessionEnd', cwd: repo, reason: 'other' }, new Date());

    const now = new Date();
    const range = { start: new Date(now.getTime() - 86400_000), end: new Date(now.getTime() + 60_000), label: 'x' };
    const stats = collectPeriodStats(db, range, { idleMinutes: 30, tickets: config.tickets });
    expect(stats.sessions[0]!.branch).toBe('feature/AUTH-42-login');
    // 同时属于 main 与功能分支的旧提交标为 main
    expect(stats.commits.find((c) => c.message === 'chore: init')?.branch).toBe('main');
    const auth = stats.tickets.find((t) => t.id === 'AUTH-42')!;
    expect(auth).toMatchObject({ projects: ['shop'], sessions: 1, commits: 2 });
    // 主分支上的初始提交不归入功能分支的工单；两次提交可能在同一秒，顺序不固定
    expect([...auth.commitMessages].sort()).toEqual(['feat: 登录页', 'fix: 顺手修复 PAY-7 的金额显示'].sort());
    expect(auth.activeSeconds).toBeGreaterThan(0);
    expect(stats.tickets.find((t) => t.id === 'PAY-7')).toMatchObject({ sessions: 0, commits: 1 });
    expect(stats.tickets[0]!.id).toBe('AUTH-42');

    expect(renderToday(stats)).toContain('AUTH-42');
    const report = buildWeeklyReport(stats, { generatedAt: now });
    expect(report).toContain('### 按工单');
    expect(report).toContain('- **PAY-7**：fix: 顺手修复 PAY-7 的金额显示');
    expect(exportRows(db, stats, 'tickets', range, config)).toEqual([
      expect.objectContaining({ ticket: 'AUTH-42', commits: 2 }),
      expect.objectContaining({ ticket: 'PAY-7', commits: 1 }),
    ]);
  });

  it('没有工单时不显示', () => {
    const stats = collectPeriodStats(db, { start: new Date(0), end: new Date(), label: 'x' }, { idleMinutes: 30 });
    expect(stats.tickets).toEqual([]);
    expect(buildWeeklyReport(stats, { generatedAt: new Date() })).not.toContain('按工单');
  });
});
