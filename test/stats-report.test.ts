import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseIsoWeek, todayRange } from '../src/core/time.js';
import type { DB } from '../src/db/database.js';
import { insertCommit } from '../src/db/repo.js';
import { buildWeeklyReport } from '../src/report/weekly.js';
import { collectPeriodStats, type PeriodStats } from '../src/stats/queries.js';
import { makeTempDir, memoryDb, rmrf, send, testConfig } from './helpers.js';

/**
 * 构造 2026-W39（2026-09-21 周一 ~ 2026-09-27 周日）的一组数据，TZ=UTC。
 *  - 会话 A（alpha）：周一 09:00~09:20 活跃，11:00~11:05 活跃 → 25 分钟
 *  - 会话 B（beta）：周一 09:05~09:25 与 A 并行 → 20 分钟；与 A 取并集后周一共 30 分钟
 *  - 会话 C（alpha）：周三 23:50 ~ 周四 00:05 跨天 → 周三 10 分钟、周四 5 分钟
 *  总计 45 分钟
 */
describe('统计与周报', () => {
  let dir: string;
  let db: DB;
  let stats: PeriodStats;
  const config = testConfig((c) => {
    c.collect.git = false;
  });

  beforeAll(() => {
    dir = makeTempDir();
    const alpha = path.join(dir, 'alpha');
    const beta = path.join(dir, 'beta');
    fs.mkdirSync(alpha);
    fs.mkdirSync(beta);
    db = memoryDb();

    const ev = (sid: string, cwd: string, at: string, event: string, extra: Record<string, unknown> = {}) =>
      send(db, config, { session_id: sid, hook_event_name: event, cwd, ...extra }, at);
    const tool = (sid: string, cwd: string, at: string, name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      ev(sid, cwd, at, 'PostToolUse', { tool_name: name, tool_input: input, tool_response: {}, ...extra });

    // 上周日的会话（不应计入本周）
    ev('old', alpha, '2026-09-20T23:00:00Z', 'SessionStart');
    ev('old', alpha, '2026-09-20T23:10:00Z', 'Stop');

    // 会话 A
    ev('A', alpha, '2026-09-21T09:00:00Z', 'SessionStart');
    tool('A', alpha, '2026-09-21T09:10:00Z', 'Edit', { file_path: path.join(alpha, 'src/a.ts') });
    tool('A', alpha, '2026-09-21T09:12:00Z', 'Bash', { command: 'npm test' }, { hook_event_name: 'PostToolUseFailure', error: 'Exit code 1' });
    tool('A', alpha, '2026-09-21T09:15:00Z', 'Edit', { file_path: path.join(alpha, 'src/a.ts') });
    tool('A', alpha, '2026-09-21T09:18:00Z', 'Bash', { command: 'npm test' }, { hook_event_name: 'PostToolUseFailure', error: 'Exit code 1' });
    ev('A', alpha, '2026-09-21T09:19:00Z', 'TaskCreated', { task_id: '1', task_subject: '实现用户登录' });
    tool('A', alpha, '2026-09-21T09:20:00Z', 'Bash', { command: 'npm test' });
    ev('A', alpha, '2026-09-21T09:20:00Z', 'TaskCompleted', { task_id: '1', task_subject: '实现用户登录' });
    tool('A', alpha, '2026-09-21T11:00:00Z', 'Write', { file_path: path.join(alpha, 'src/b.ts') }, { tool_response: { type: 'create' } });
    tool('A', alpha, '2026-09-21T11:02:00Z', 'Edit', { file_path: path.join(alpha, 'src/a.ts') });
    tool('A', alpha, '2026-09-21T11:04:00Z', 'Bash', { command: 'npm run build' });
    ev('A', alpha, '2026-09-21T11:05:00Z', 'SessionEnd', { reason: 'prompt_input_exit' });

    // 会话 B
    ev('B', beta, '2026-09-21T09:05:00Z', 'SessionStart');
    tool('B', beta, '2026-09-21T09:15:00Z', 'Edit', { file_path: path.join(beta, 'README.md') });
    ev('B', beta, '2026-09-21T09:25:00Z', 'Stop');
    ev('B', beta, '2026-09-21T09:25:00Z', 'SessionEnd', { reason: 'other' });

    // 会话 C（跨天）
    ev('C', alpha, '2026-09-23T23:50:00Z', 'SessionStart');
    ev('C', alpha, '2026-09-23T23:55:00Z', 'UserPromptSubmit', { prompt: 'x' });
    ev('C', alpha, '2026-09-24T00:05:00Z', 'Stop');

    // 周二的两个提交
    const alphaId = (db.prepare("SELECT id FROM projects WHERE name = 'alpha'").get() as { id: number }).id;
    for (const [hash, ts, msg] of [
      ['a'.repeat(40), '2026-09-22T10:00:00.000Z', 'feat: 登录接口'],
      ['b'.repeat(40), '2026-09-22T15:00:00.000Z', 'test: 登录测试'],
    ] as const) {
      insertCommit(db, {
        projectId: alphaId,
        hash,
        branch: 'main',
        message: msg,
        author: 'Dev',
        timestamp: ts,
        filesChanged: 2,
        insertions: 30,
        deletions: 5,
      });
    }

    stats = collectPeriodStats(db, parseIsoWeek('2026-W39')!, { idleMinutes: 30 });
  });

  afterAll(() => {
    db.close();
    rmrf(dir);
  });

  it('活跃时长：空闲不计、并行取并集、跨天拆分', () => {
    expect(stats.activeSeconds).toBe(45 * 60);
    const daily = Object.fromEntries(stats.daily.map((d) => [d.date, d.activeSeconds / 60]));
    expect(daily).toEqual({
      '2026-09-21': 30,
      '2026-09-22': 0,
      '2026-09-23': 10,
      '2026-09-24': 5,
      '2026-09-25': 0,
      '2026-09-26': 0,
      '2026-09-27': 0,
    });
    expect(stats.activeDays).toBe(4); // 周一、周二（有提交）、周三、周四
  });

  it('按项目汇总', () => {
    const byName = Object.fromEntries(stats.projects.map((p) => [p.name, p]));
    expect(Object.keys(byName)).toEqual(['alpha', 'beta']);
    expect(byName.alpha).toMatchObject({
      activeSeconds: 40 * 60,
      sessions: 2,
      commits: 2,
      insertions: 60,
      deletions: 10,
      files: 2,
      fileEdits: 4,
      commands: 4,
      commandFailures: 2,
      tasksCompleted: 1,
    });
    expect(byName.beta).toMatchObject({ activeSeconds: 20 * 60, sessions: 1, files: 1 });
  });

  it('会话、文件、命令、提交、任务', () => {
    expect(stats.sessions.map((s) => s.sessionId).sort()).toEqual(['A', 'B', 'C']);
    expect(stats.runningSessions).toBe(1); // C 没有 SessionEnd
    expect(stats.files).toMatchObject({ distinct: 3, edits: 5, created: 1 });
    expect(stats.files.top[0]).toMatchObject({ path: 'src/a.ts', edits: 3 });
    expect(stats.commands.total).toBe(4);
    expect(stats.commands.failed).toBe(2);
    expect(stats.commands.failures[0]).toMatchObject({ command: 'npm test', count: 2, lastExitCode: 1 });
    expect(stats.commitTotals).toEqual({ count: 2, insertions: 60, deletions: 10, filesChanged: 4 });
    expect(stats.tasks.completed.map((t) => t.title)).toEqual(['实现用户登录']);
    expect(stats.prompts).toBe(1);
    expect(stats.tools.find((t) => t.tool === 'Bash')).toEqual({ tool: 'Bash', count: 4, failures: 2 });
  });

  it('按项目过滤', () => {
    const betaId = stats.projects.find((p) => p.name === 'beta')!.id;
    const only = collectPeriodStats(db, parseIsoWeek('2026-W39')!, { idleMinutes: 30, projectId: betaId });
    expect(only.activeSeconds).toBe(20 * 60);
    expect(only.projects.map((p) => p.name)).toEqual(['beta']);
    expect(only.commits).toHaveLength(0);
  });

  it('当天统计只包含当天数据', () => {
    const monday = collectPeriodStats(db, todayRange(new Date('2026-09-21T12:00:00Z')), { idleMinutes: 30 });
    expect(monday.activeSeconds).toBe(30 * 60);
    expect(monday.sessions.map((s) => s.sessionId).sort()).toEqual(['A', 'B']);
  });

  it('生成周报 Markdown，包含全部章节', () => {
    const md = buildWeeklyReport(stats, { generatedAt: new Date('2026-09-27T20:00:00Z') });
    expect(md).toContain('# DevTrack 开发周报 · 2026-W39');
    for (const section of ['## 一、本周开发概况', '## 二、项目', '## 三、完成任务', '## 四、Git 活动', '## 五、文件修改', '## 六、技术问题']) {
      expect(md).toContain(section);
    }
    expect(md).toContain('| 开发时长（活跃） | 45分钟 |');
    expect(md).toContain('- [x] 实现用户登录（alpha，周一）');
    expect(md).toContain('feat: 登录接口');
    expect(md).toContain('`npm test`（alpha）失败 2 次，最近退出码 1');
    expect(md).toContain('测试命令执行 3 次，失败 2 次（失败率 67%）');
    expect(md).not.toContain('七、AI 总结');
  });

  it('周报包含 AI 总结或失败原因', () => {
    const withAi = buildWeeklyReport(stats, {
      generatedAt: new Date(),
      aiSummary: { text: '### 本周工作概述\n完成登录功能。', provider: 'anthropic', model: 'claude-opus-5' },
    });
    expect(withAi).toContain('## 七、AI 总结');
    expect(withAi).toContain('完成登录功能。');
    const failed = buildWeeklyReport(stats, { generatedAt: new Date(), aiError: '未找到 API Key' });
    expect(failed).toContain('> AI 总结生成失败：未找到 API Key');
  });

  it('没有 Claude 任务时从 Git 提交推断', () => {
    const noTasks = { ...stats, tasks: { created: 0, open: 0, completed: [] } };
    const md = buildWeeklyReport(noTasks, { generatedAt: new Date() });
    expect(md).toContain('以下根据 Git 提交推断');
    expect(md).toContain('- [x] feat: 登录接口（alpha，周二）');
  });
});
