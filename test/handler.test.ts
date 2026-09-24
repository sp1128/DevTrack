import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DevTrackConfig } from '../src/config.js';
import type { DB } from '../src/db/database.js';
import { commitFile, createRepo, git, makeTempDir, memoryDb, rmrf, rows, send, testConfig } from './helpers.js';

describe('Hook 事件处理', () => {
  let dir: string;
  let repo: string;
  let db: DB;
  let config: DevTrackConfig;
  const sid = 'session-abc';

  beforeEach(() => {
    dir = makeTempDir();
    repo = createRepo(path.join(dir, 'project-a'));
    db = memoryDb();
    config = testConfig();
  });
  afterEach(() => {
    db.close();
    rmrf(dir);
  });

  const start = (at = new Date(), extra: Record<string, unknown> = {}) =>
    send(db, config, { session_id: sid, hook_event_name: 'SessionStart', cwd: repo, source: 'startup', model: 'claude-opus-5', ...extra }, at);

  const bash = (command: string, extra: Record<string, unknown> = {}, event = 'PostToolUse') =>
    send(db, config, { session_id: sid, hook_event_name: event, cwd: repo, tool_name: 'Bash', tool_input: { command }, ...extra });

  it('自动识别项目（含子目录与 git 信息），无需手动注册', () => {
    git(repo, ['remote', 'add', 'origin', 'https://user:secret-token@github.com/me/project-a.git']);
    const sub = path.join(repo, 'packages', 'core');
    fs.mkdirSync(sub, { recursive: true });
    const result = send(db, config, { session_id: sid, hook_event_name: 'SessionStart', cwd: sub, source: 'startup', model: 'claude-opus-5' });
    expect(result.status).toBe('recorded');
    const [project] = rows<{ name: string; path: string; git_remote: string; is_git: number }>(db, 'SELECT * FROM projects');
    expect(project!.name).toBe('project-a');
    expect(project!.path).toBe(repo);
    expect(project!.is_git).toBe(1);
    // remote 中的凭据被移除
    expect(project!.git_remote).toBe('https://github.com/me/project-a.git');
    const [session] = rows<{ cwd: string; git_branch: string; status: string; model: string }>(db, 'SELECT * FROM sessions');
    expect(session).toMatchObject({ cwd: sub, git_branch: 'main', status: 'active', model: 'claude-opus-5' });
  });

  it('非 git 目录也能识别为项目', () => {
    const plain = path.join(dir, 'notes');
    fs.mkdirSync(plain);
    send(db, config, { session_id: 's2', hook_event_name: 'UserPromptSubmit', cwd: plain, prompt: 'hi' });
    const [project] = rows<{ name: string; is_git: number }>(db, 'SELECT * FROM projects');
    expect(project).toMatchObject({ name: 'notes', is_git: 0 });
  });

  it('记录会话开始 / 结束与时长', () => {
    start(new Date('2026-09-24T09:00:00Z'));
    send(db, config, { session_id: sid, hook_event_name: 'SessionEnd', cwd: repo, reason: 'prompt_input_exit' }, '2026-09-24T09:45:00Z');
    const [session] = rows<Record<string, unknown>>(db, 'SELECT * FROM sessions');
    expect(session).toMatchObject({
      status: 'ended',
      started_at: '2026-09-24T09:00:00.000Z',
      ended_at: '2026-09-24T09:45:00.000Z',
      duration_seconds: 2700,
      end_reason: 'prompt_input_exit',
      source: 'startup',
    });
    // resume 后收到新事件会重新打开会话
    start(new Date('2026-09-24T10:00:00Z'), { source: 'resume' });
    const [reopened] = rows<Record<string, unknown>>(db, 'SELECT status, ended_at, source FROM sessions');
    expect(reopened).toEqual({ status: 'active', ended_at: null, source: 'resume' });
  });

  it('不保存提示词内容，只记录长度', () => {
    start();
    send(db, config, { session_id: sid, hook_event_name: 'UserPromptSubmit', cwd: repo, prompt: '我的密码是 hunter2，帮我写登录' });
    const dump = JSON.stringify(rows(db, 'SELECT * FROM events')) + JSON.stringify(rows(db, 'SELECT * FROM sessions'));
    expect(dump).not.toContain('hunter2');
    expect(dump).not.toContain('登录');
    const [prompt] = rows<{ metadata: string }>(db, "SELECT metadata FROM events WHERE type = 'prompt'");
    expect(JSON.parse(prompt!.metadata)).toEqual({ length: 19 });
  });

  it('开启 promptSummary 后保存脱敏的首条提示词摘要作为会话标题', () => {
    config.collect.promptSummary = true;
    start();
    send(db, config, {
      session_id: sid,
      hook_event_name: 'UserPromptSubmit',
      cwd: repo,
      prompt: '修复登录接口 api_key=abc123 的问题\n详细描述……',
    });
    send(db, config, { session_id: sid, hook_event_name: 'UserPromptSubmit', cwd: repo, prompt: '第二条' });
    const [session] = rows<{ title: string }>(db, 'SELECT title FROM sessions');
    expect(session!.title).toBe('修复登录接口 api_key=[REDACTED] 的问题');
  });

  it('记录命令：脱敏、分类、退出码、耗时，忽略琐碎命令', () => {
    start();
    bash('API_TOKEN=abc npm test', { tool_response: { stdout: 'ok' }, duration_ms: 1234.4 });
    bash('npm run build', { error: 'Exit code 2\nsrc/a.ts(1,1): error TS2322', duration_ms: 800 }, 'PostToolUseFailure');
    bash('npm run dev', { tool_input: { command: 'npm run dev', run_in_background: true }, tool_response: {} });
    bash('pytest', { error: 'Interrupted', is_interrupt: true }, 'PostToolUseFailure');
    bash('ls -la', { tool_response: {} });
    bash('git status', { tool_response: {} });
    const cmds = rows<Record<string, unknown>>(db, 'SELECT command, category, exit_code, duration_ms, status FROM commands ORDER BY id');
    expect(cmds).toEqual([
      { command: 'API_TOKEN=[REDACTED] npm test', category: 'test', exit_code: 0, duration_ms: 1234, status: 'success' },
      { command: 'npm run build', category: 'build', exit_code: 2, duration_ms: 800, status: 'failure' },
      { command: 'npm run dev', category: 'run', exit_code: null, duration_ms: null, status: 'background' },
      { command: 'pytest', category: 'test', exit_code: null, duration_ms: null, status: 'interrupted' },
    ]);
    // 被忽略的命令仍然算作工具调用（用于活跃时长）
    const toolEvents = rows<{ c: number }>(db, "SELECT COUNT(*) AS c FROM events WHERE tool_name = 'Bash'");
    expect(toolEvents[0]!.c).toBe(6);
  });

  it('记录文件修改：Write 新建、Edit 修改；路径相对项目；忽略临时目录', () => {
    start();
    send(db, config, {
      session_id: sid,
      hook_event_name: 'PostToolUse',
      cwd: repo,
      tool_name: 'Write',
      tool_input: { file_path: path.join(repo, 'src', 'new.ts'), content: 'export const SECRET_CODE = 1' },
      tool_response: { filePath: path.join(repo, 'src', 'new.ts'), type: 'create' },
    });
    send(db, config, {
      session_id: sid,
      hook_event_name: 'PostToolUse',
      cwd: repo,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(repo, 'README.md'), old_string: 'a', new_string: 'b' },
      tool_response: {},
    });
    send(db, config, {
      session_id: sid,
      hook_event_name: 'PostToolUse',
      cwd: repo,
      tool_name: 'Write',
      scratchpad_dir: path.join(dir, 'scratch'),
      tool_input: { file_path: path.join(dir, 'scratch', 'notes.md'), content: 'x' },
      tool_response: { type: 'create' },
    });
    const files = rows<Record<string, unknown>>(db, 'SELECT file_path, action, source, tool_name FROM file_changes ORDER BY id');
    expect(files).toEqual([
      { file_path: 'src/new.ts', action: 'create', source: 'claude', tool_name: 'Write' },
      { file_path: 'README.md', action: 'modify', source: 'claude', tool_name: 'Edit' },
    ]);
    // 源代码内容不会进入数据库
    expect(JSON.stringify(rows(db, 'SELECT * FROM events'))).not.toContain('SECRET_CODE');
  });

  it('使用 bashEditDiff 记录 Bash 命令修改的文件', () => {
    start();
    bash('sed -i s/a/b/ src/x.ts && rm old.ts', {
      tool_response: {
        bashEditDiff: {
          changedFiles: [path.join(repo, 'src/x.ts'), path.join(repo, 'old.ts')],
          files: [{ filePath: path.join(repo, 'old.ts'), deleted: true, hunks: [] }],
          moreFiles: 0,
        },
      },
    });
    const files = rows<Record<string, unknown>>(db, 'SELECT file_path, action, source FROM file_changes ORDER BY id');
    expect(files).toEqual([
      { file_path: 'src/x.ts', action: 'modify', source: 'bash' },
      { file_path: 'old.ts', action: 'delete', source: 'bash' },
    ]);
  });

  it('通过 git status 快照补充 Claude 工具之外的文件变化（不重复记录）', () => {
    fs.writeFileSync(path.join(repo, 'dirty-before.txt'), 'pre-existing');
    start();
    // Claude 用 Edit 修改了 README.md（已记录），Bash / 编辑器新增了 gen.ts、删除了……
    send(db, config, {
      session_id: sid,
      hook_event_name: 'PostToolUse',
      cwd: repo,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(repo, 'README.md') },
    });
    fs.appendFileSync(path.join(repo, 'README.md'), 'more\n');
    fs.writeFileSync(path.join(repo, 'gen.ts'), 'generated');
    send(db, config, { session_id: sid, hook_event_name: 'Stop', cwd: repo });
    const files = rows<Record<string, unknown>>(db, 'SELECT file_path, action, source FROM file_changes ORDER BY id');
    expect(files).toEqual([
      { file_path: 'README.md', action: 'modify', source: 'claude' },
      { file_path: 'gen.ts', action: 'create', source: 'git' },
    ]);
    // 第二次 Stop 没有新变化，不重复记录
    send(db, config, { session_id: sid, hook_event_name: 'Stop', cwd: repo });
    expect(rows(db, 'SELECT * FROM file_changes')).toHaveLength(2);
    // 关闭 trackWorkingTree 后不再对比
    config.git.trackWorkingTree = false;
    fs.writeFileSync(path.join(repo, 'another.ts'), 'x');
    send(db, config, { session_id: sid, hook_event_name: 'Stop', cwd: repo });
    expect(rows(db, 'SELECT * FROM file_changes')).toHaveLength(2);
  });

  it('上下文压缩（SessionStart source=compact）不会丢失压缩前的文件变化', () => {
    start();
    fs.writeFileSync(path.join(repo, 'before-compact.ts'), 'x');
    send(db, config, { session_id: sid, hook_event_name: 'SessionStart', cwd: repo, source: 'compact' });
    const files = rows<{ file_path: string; source: string }>(db, 'SELECT file_path, source FROM file_changes');
    expect(files).toEqual([{ file_path: 'before-compact.ts', source: 'git' }]);
  });

  it('读取 Git 提交：分支、说明、作者、增删行数，并关联会话；只统计当前用户', () => {
    const at = new Date();
    start(at);
    commitFile(repo, 'src/a.ts', 'line1\nline2\n', 'feat: 新增 a 模块');
    commitFile(repo, 'src/b.ts', 'x\n', 'fix: 其他人的提交', undefined);
    git(repo, ['commit', '--amend', '-q', '--no-edit', '--author', 'Other <other@example.com>']);
    send(db, config, { session_id: sid, hook_event_name: 'SessionEnd', cwd: repo, reason: 'other' }, new Date(Date.now() + 1000));
    const commits = rows<Record<string, unknown>>(
      db,
      'SELECT branch, message, author, files_changed, insertions, deletions, session_id FROM git_commits ORDER BY timestamp, id',
    );
    const messages = commits.map((c) => c.message);
    expect(messages).toContain('feat: 新增 a 模块');
    expect(messages).toContain('chore: init');
    expect(messages).not.toContain('fix: 其他人的提交');
    const feat = commits.find((c) => c.message === 'feat: 新增 a 模块')!;
    expect(feat).toMatchObject({ branch: 'main', author: 'Dev', files_changed: 1, insertions: 2, deletions: 0 });
    expect(feat.session_id).not.toBeNull();

    // authorOnly=false 时统计所有人的提交；重复扫描按 hash 去重
    config.git.authorOnly = false;
    db.prepare('UPDATE projects SET last_git_scan_at = NULL').run();
    send(db, config, { session_id: sid, hook_event_name: 'Stop', cwd: repo });
    const all = rows<{ message: string }>(db, 'SELECT message FROM git_commits');
    expect(all.map((c) => c.message)).toContain('fix: 其他人的提交');
    expect(new Set(all.map((c) => c.message)).size).toBe(all.length);
  });

  it('提交说明也会脱敏', () => {
    start();
    commitFile(repo, 'x.txt', 'x', 'chore: rotate key sk-ant-api03-abcdefghijklmnopqrstuv');
    send(db, config, { session_id: sid, hook_event_name: 'SessionEnd', cwd: repo, reason: 'other' });
    const msgs = rows<{ message: string }>(db, 'SELECT message FROM git_commits').map((r) => r.message);
    expect(msgs.join()).not.toContain('sk-ant');
    expect(msgs).toContain('chore: rotate key [REDACTED]');
  });

  it('识别任务：TaskCreated / TaskCompleted / TaskUpdate / TodoWrite', () => {
    start();
    send(db, config, { session_id: sid, hook_event_name: 'TaskCreated', cwd: repo, task_id: 'task-1', task_subject: '实现登录', task_description: '新增 /login 接口' });
    send(db, config, { session_id: sid, hook_event_name: 'TaskCreated', cwd: repo, task_id: 'task-2', task_subject: '补充测试' });
    send(db, config, { session_id: sid, hook_event_name: 'PostToolUse', cwd: repo, tool_name: 'TaskUpdate', tool_input: { taskId: 'task-2', status: 'in_progress' } });
    send(db, config, { session_id: sid, hook_event_name: 'TaskCompleted', cwd: repo, task_id: 'task-1', task_subject: '实现登录' });
    send(db, config, {
      session_id: sid,
      hook_event_name: 'PostToolUse',
      cwd: repo,
      tool_name: 'TodoWrite',
      tool_input: {
        todos: [
          { content: '阅读代码', status: 'completed', activeForm: '阅读代码中' },
          { content: '修改配置', status: 'pending', activeForm: '修改配置中' },
        ],
      },
    });
    const tasks = rows<Record<string, unknown>>(db, 'SELECT external_id, source, title, status, completed_at IS NOT NULL AS done FROM tasks ORDER BY id');
    expect(tasks).toEqual([
      { external_id: 'task-1', source: 'task', title: '实现登录', status: 'completed', done: 1 },
      { external_id: 'task-2', source: 'task', title: '补充测试', status: 'in_progress', done: 0 },
      { external_id: '阅读代码', source: 'todo', title: '阅读代码', status: 'completed', done: 1 },
      { external_id: '修改配置', source: 'todo', title: '修改配置', status: 'pending', done: 0 },
    ]);
  });

  it('关闭某类采集后不再记录该类数据', () => {
    config.collect.commands = false;
    config.collect.fileChanges = false;
    config.collect.tasks = false;
    config.collect.git = false;
    start();
    bash('npm test', { tool_response: {} });
    send(db, config, { session_id: sid, hook_event_name: 'PostToolUse', cwd: repo, tool_name: 'Write', tool_input: { file_path: path.join(repo, 'a.ts') }, tool_response: { type: 'create' } });
    send(db, config, { session_id: sid, hook_event_name: 'TaskCreated', cwd: repo, task_id: '1', task_subject: 'x' });
    send(db, config, { session_id: sid, hook_event_name: 'SessionEnd', cwd: repo, reason: 'other' });
    for (const table of ['commands', 'file_changes', 'tasks', 'git_commits']) {
      expect(rows(db, `SELECT * FROM ${table}`), table).toHaveLength(0);
    }
    // 会话与工具事件仍记录（不含内容），用于计算开发时长
    expect(rows(db, 'SELECT * FROM events').length).toBeGreaterThan(0);
  });

  it('总开关关闭或项目被排除时什么都不记录', () => {
    config.enabled = false;
    expect(start().status).toBe('skipped');
    config.enabled = true;
    config.privacy.excludeProjects = ['project-a'];
    expect(start()).toEqual({ status: 'skipped', reason: 'excluded' });
    config.privacy.excludeProjects = [path.dirname(repo)];
    expect(start()).toEqual({ status: 'skipped', reason: 'excluded' });
    for (const table of ['projects', 'sessions', 'events']) expect(rows(db, `SELECT * FROM ${table}`), table).toHaveLength(0);
  });

  it('没有 SessionStart 也能从任意事件建立会话；未知会话的 SessionEnd 被忽略', () => {
    expect(send(db, config, { session_id: 'ghost', hook_event_name: 'SessionEnd', cwd: repo, reason: 'other' })).toEqual({
      status: 'skipped',
      reason: 'unknown-session',
    });
    bash('npm test', { tool_response: {} });
    expect(rows(db, 'SELECT session_id FROM sessions')).toEqual([{ session_id: sid }]);
    expect(rows(db, 'SELECT * FROM commands')).toHaveLength(1);
  });

  it('长时间无活动的会话在下一次 SessionStart 时标记为已中断', () => {
    send(db, config, { session_id: 'old', hook_event_name: 'SessionStart', cwd: repo }, '2026-09-20T09:00:00Z');
    send(db, config, { session_id: 'old', hook_event_name: 'Stop', cwd: repo }, '2026-09-20T09:30:00Z');
    send(db, config, { session_id: 'new', hook_event_name: 'SessionStart', cwd: repo }, '2026-09-24T09:00:00Z');
    const [old] = rows<Record<string, unknown>>(db, "SELECT status, ended_at, duration_seconds FROM sessions WHERE session_id = 'old'");
    expect(old).toEqual({ status: 'abandoned', ended_at: '2026-09-20T09:30:00.000Z', duration_seconds: 1800 });
  });

  it('未知事件类型也能安全记录', () => {
    start();
    send(db, config, { session_id: sid, hook_event_name: 'SubagentStop', cwd: repo, agent_type: 'Explore' });
    expect(rows(db, "SELECT type FROM events WHERE type = 'subagent_stop'")).toHaveLength(1);
  });
});
