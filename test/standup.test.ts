import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/db/database.js';
import { resetLang, setLang } from '../src/i18n.js';
import type { AnthropicLike } from '../src/report/ai.js';
import { buildStandupPayload, collectStandup, generateAiStandup, renderStandup } from '../src/report/standup.js';
import { makeTempDir, memoryDb, rmrf, send, testConfig } from './helpers.js';

describe('站会摘要', () => {
  let dir: string;
  let db: DB;
  const config = testConfig((c) => (c.collect.git = false));
  const cwd = () => path.join(dir, 'shop');
  // 2026-09-28 是周一
  const now = new Date(2026, 8, 28, 11, 0);
  const at = (day: number, h: number, m = 0) => new Date(2026, 8, day, h, m);

  function session(id: string, day: number, events: (base: Record<string, unknown>) => void = () => {}) {
    const base = { session_id: id, cwd: cwd() };
    send(db, config, { ...base, hook_event_name: 'SessionStart' }, at(day, 9));
    events(base);
    send(db, config, { ...base, hook_event_name: 'SessionEnd', reason: 'other' }, at(day, 10));
  }

  function commit(day: number, message: string) {
    db.prepare(
      `INSERT INTO git_commits (project_id, hash, branch, message, author, timestamp, files_changed, insertions, deletions)
       VALUES (1, ?, 'feature/AUTH-42-login', ?, 'dev', ?, 1, 10, 2)`,
    ).run(`h${Math.random()}`, message, at(day, 9, 30).toISOString());
  }

  beforeEach(() => {
    dir = makeTempDir();
    fs.mkdirSync(cwd());
    db = memoryDb();
  });
  afterEach(() => {
    resetLang();
    db.close();
    rmrf(dir);
  });

  it('上一个工作日（跳过周末）与今天，按项目列出提交、摘要、任务与失败命令', () => {
    // 周五
    session('fri', 25, (base) => {
      send(db, config, { ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {} }, at(25, 9, 20));
      send(db, config, { ...base, hook_event_name: 'TaskCompleted', task_id: '1', task_subject: '实现登录页' }, at(25, 9, 40));
      send(
        db,
        config,
        { ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1' },
        at(25, 9, 50),
      );
    });
    commit(25, 'feat: 登录页 AUTH-42');
    db.prepare("UPDATE sessions SET summary = '实现登录页并补充测试' WHERE session_id = 'fri'").run();
    // 今天：只有文件修改
    session('mon', 28, (base) => {
      send(
        db,
        config,
        { ...base, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(cwd(), 'a.ts') }, tool_response: { type: 'create' } },
        at(28, 9, 10),
      );
    });

    const data = collectStandup(db, now, { idleMinutes: 30 });
    expect(data.previous!.date).toBe('2026-09-25');
    const text = renderStandup(data, now);
    expect(text).toContain('站会 · 2026-09-28（周一）');
    expect(text).toContain('上次（周五 09-25）');
    expect(text).toContain('今天（周一 09-28）');
    expect(text).toContain('• shop [AUTH-42]');
    expect(text).toContain('    - feat: 登录页 AUTH-42');
    expect(text).toContain('    - 实现登录页并补充测试');
    expect(text).toContain('    - 实现登录页');
    expect(text).toContain('修改 1 个文件，执行命令 0 次');
    expect(text).toContain('测试：npm test（shop） 失败 1 次');

    setLang('en');
    const en = renderStandup(collectStandup(db, now, { idleMinutes: 30 }), now);
    expect(en).toContain('Last active (Fri 09-25)');
    expect(en).toContain('Test: npm test (shop) failed once');
  });

  it('紧挨着的前一天显示为"昨天"；没有更早的记录时只显示今天', () => {
    expect(collectStandup(db, now, { idleMinutes: 30 }).previous).toBeNull();
    expect(renderStandup(collectStandup(db, now, { idleMinutes: 30 }), now)).toContain('暂无记录');
    session('sun', 27, (base) => send(db, config, { ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {} }, at(27, 9, 5)));
    expect(renderStandup(collectStandup(db, now, { idleMinutes: 30 }), now)).toContain('昨天（周日 09-27）');
  });

  it('AI 版本：默认用 Haiku，只发送统计数据', async () => {
    session('fri', 25, (base) =>
      send(
        db,
        config,
        { ...base, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(cwd(), 'secret-plan.ts') }, tool_response: {} },
        at(25, 9, 5),
      ),
    );
    commit(25, 'feat: 登录页');
    const calls: Record<string, unknown>[] = [];
    const client: AnthropicLike = {
      beta: {
        messages: {
          create: async (params) => {
            calls.push(params);
            return { stop_reason: 'end_turn', model: 'm', content: [{ type: 'text', text: '**昨天**\n- 登录页' }] };
          },
        },
      },
    };
    const data = collectStandup(db, now, { idleMinutes: 30 });
    const result = await generateAiStandup(data, config, { env: { ANTHROPIC_API_KEY: 'k' }, createAnthropic: async () => client });
    expect(result.text).toContain('登录页');
    expect(calls[0]!.model).toBe('claude-haiku-4-5');
    const sent = JSON.stringify(calls[0]!.messages);
    expect(sent).toContain('feat: 登录页');
    expect(sent).not.toContain('secret-plan');
    expect(buildStandupPayload(data).today).toMatchObject({ date: '2026-09-28', projects: [] });
  });
});
