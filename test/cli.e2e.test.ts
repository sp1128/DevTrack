import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitFile, createRepo, makeTempDir, rmrf } from './helpers.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

describe('CLI 端到端（dist/cli.js）', () => {
  let root: string;
  let home: string;
  let claudeDir: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;

  const run = (args: string[], input?: string) => {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      env,
      input,
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const hook = (payload: unknown) => run(['hook', '--devtrack-managed'], typeof payload === 'string' ? payload : JSON.stringify(payload));

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error('dist/cli.js 不存在，请先运行 npm run build');
    root = makeTempDir();
    home = path.join(root, 'devtrack');
    claudeDir = path.join(root, 'claude');
    repo = createRepo(path.join(root, 'my-app'));
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] } }),
    );
    env = { ...process.env, DEVTRACK_HOME: home, CLAUDE_CONFIG_DIR: claudeDir, TZ: 'UTC', NO_COLOR: '1' };
    delete env.FORCE_COLOR;
  });

  afterAll(() => rmrf(root));

  it('--version 与 --help', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(run(['--version']).stdout.trim()).toBe(pkg.version);
    const help = run(['--help']).stdout;
    for (const cmd of ['init', 'doctor', 'today', 'week', 'month', 'project', 'report', 'stats', 'purge', 'reset']) {
      expect(help).toContain(cmd);
    }
  });

  it('init：创建数据目录、配置、数据库并安装 Hook（保留已有 Hook）', () => {
    const r = run(['init']);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(home, 'devtrack.db'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'config.json'))).toBe(true);
    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.hooks.Stop[0].hooks[0].command).toBe('echo existing');
    expect(settings.hooks.Stop[1].hooks[0].args).toEqual([CLI, 'hook', '--devtrack-managed']);
    expect(settings.hooks.SessionStart).toBeDefined();
  });

  it('hook：任何输入都以 0 退出且 stdout 为空', () => {
    const sid = 'e2e-session';
    const events = [
      { session_id: sid, hook_event_name: 'SessionStart', cwd: repo, source: 'startup' },
      { session_id: sid, hook_event_name: 'UserPromptSubmit', cwd: repo, prompt: '实现 feature' },
      {
        session_id: sid,
        hook_event_name: 'PostToolUse',
        cwd: repo,
        tool_name: 'Write',
        tool_input: { file_path: path.join(repo, 'src/index.ts'), content: 'export {}' },
        tool_response: { type: 'create', filePath: path.join(repo, 'src/index.ts') },
        duration_ms: 5,
      },
      { session_id: sid, hook_event_name: 'PostToolUse', cwd: repo, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: {} },
      { session_id: sid, hook_event_name: 'TaskCreated', cwd: repo, task_id: '1', task_subject: '搭建项目骨架' },
      { session_id: sid, hook_event_name: 'TaskCompleted', cwd: repo, task_id: '1', task_subject: '搭建项目骨架' },
    ];
    for (const e of events) {
      const r = hook(e);
      expect(r.code, e.hook_event_name).toBe(0);
      expect(r.stdout, e.hook_event_name).toBe('');
    }
    commitFile(repo, 'src/index.ts', 'export {}\n', 'feat: 项目骨架');
    for (const e of [
      { session_id: sid, hook_event_name: 'Stop', cwd: repo },
      { session_id: sid, hook_event_name: 'SessionEnd', cwd: repo, reason: 'prompt_input_exit' },
    ]) {
      expect(hook(e)).toMatchObject({ code: 0, stdout: '' });
    }
    // 异常输入
    for (const bad of ['', 'not json', '[]', '{}', JSON.stringify({ session_id: 1 })]) {
      expect(hook(bad), bad).toMatchObject({ code: 0, stdout: '' });
    }
    const log = fs.readFileSync(path.join(home, 'logs', 'devtrack.log'), 'utf8');
    expect(log).toContain('stdin 不是合法的 JSON');
  });

  it('hook：数据库不可用时仍以 0 退出（Tracker 出错不影响 Claude Code）', () => {
    const brokenHome = path.join(root, 'broken');
    fs.mkdirSync(brokenHome);
    fs.writeFileSync(path.join(brokenHome, 'devtrack.db'), 'this is not a sqlite database');
    const r = spawnSync(process.execPath, [CLI, 'hook'], {
      env: { ...env, DEVTRACK_HOME: brokenHome },
      input: JSON.stringify({ session_id: 'x', hook_event_name: 'SessionStart', cwd: repo }),
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(fs.readFileSync(path.join(brokenHome, 'logs', 'devtrack.log'), 'utf8')).toContain('[error] hook:SessionStart');
  });

  it('today / week / month / project / stats 正常输出', () => {
    const today = run(['today']);
    expect(today.code).toBe(0);
    expect(today.stdout).toContain('今天');
    expect(today.stdout).toContain('my-app');
    expect(today.stdout).toContain('feat: 项目骨架');
    expect(today.stdout).toContain('搭建项目骨架');

    const json = JSON.parse(run(['today', '--json']).stdout);
    expect(json.sessions).toHaveLength(1);
    expect(json.commits.map((c: { message: string }) => c.message)).toContain('feat: 项目骨架');
    expect(json.files.distinct).toBe(1);
    expect(json.tasks.completed).toHaveLength(1);
    expect(json.commands.total).toBe(1);

    for (const args of [['week'], ['week', '--last'], ['month'], ['project'], ['project', 'my-app'], ['project', repo], ['stats']]) {
      const r = run(args);
      expect(r.code, args.join(' ')).toBe(0);
      expect(r.stdout.length, args.join(' ')).toBeGreaterThan(0);
    }
    expect(run(['project', 'does-not-exist']).code).toBe(1);
    expect(run(['week', '--week', 'bad']).code).toBe(1);
  });

  it('report：生成 ~/.devtrack/reports/<年>-W<周>.md', () => {
    const r = run(['report', '--week', '2026-W39']);
    expect(r.code).toBe(0);
    const file = path.join(home, 'reports', '2026-W39.md');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain('# DevTrack 开发周报 · 2026-W39');
    const current = run(['report', '--stdout']);
    expect(current.stdout).toContain('## 六、技术问题');
  });

  it('report --ai --dry-run 只打印将发送的数据', () => {
    const r = run(['report', '--ai', '--dry-run']);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.totals.sessions).toBe(1);
    expect(r.stdout).not.toContain(repo);
  });

  it('config：读取与修改', () => {
    expect(run(['config', 'set', 'collect.commands', 'false']).code).toBe(0);
    expect(run(['config', 'get', 'collect.commands']).stdout.trim()).toBe('false');
    expect(run(['config', 'set', 'collect.bogus', 'true']).code).toBe(1);
    expect(run(['config', 'reset']).code).toBe(0);
    expect(run(['config', 'get', 'collect.commands']).stdout.trim()).toBe('true');
  });

  it('doctor 输出每一项检查', () => {
    const r = run(['doctor', '--json']);
    const result = JSON.parse(r.stdout);
    const names = result.checks.map((c: { name: string }) => c.name);
    for (const name of ['Node.js', 'Git', 'Claude Code', 'Claude Code Hooks', 'SQLite', 'Database', 'Configuration', 'File permissions']) {
      expect(names).toContain(name);
    }
    const hooks = result.checks.find((c: { name: string }) => c.name === 'Claude Code Hooks');
    expect(hooks.status).toBe('ok');
    expect(result.checks.find((c: { name: string }) => c.name === 'Database').status).toBe('ok');
  });

  it('purge --before 删除旧数据', () => {
    const db = new Database(path.join(home, 'devtrack.db'));
    db.prepare(
      "INSERT INTO events (session_id, project_id, type, timestamp) VALUES (NULL, NULL, 'tool_use', '2020-01-01T00:00:00.000Z')",
    ).run();
    db.close();
    const dry = run(['purge', '--before', '30d', '--dry-run']);
    expect(dry.stdout).toContain('--dry-run');
    const noYes = run(['purge', '--before', '30d']);
    expect(noYes.code).toBe(1); // 非交互终端必须 --yes
    const r = run(['purge', '--before', '30d', '--yes']);
    expect(r.code).toBe(0);
    const check = new Database(path.join(home, 'devtrack.db'), { readonly: true });
    const old = check.prepare("SELECT COUNT(*) AS c FROM events WHERE timestamp < '2021-01-01'").get() as { c: number };
    const recent = check.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number };
    check.close();
    expect(old.c).toBe(0);
    expect(recent.c).toBeGreaterThan(0);
    expect(run(['purge', '--before', 'someday', '--yes']).code).toBe(1);
  });

  it('uninstall 移除 Hook；reset 清空数据', () => {
    expect(run(['uninstall']).code).toBe(0);
    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    expect(settings).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] } });

    expect(run(['reset']).code).toBe(1); // 非交互终端必须 --yes
    expect(run(['reset', '--yes']).code).toBe(0);
    expect(fs.existsSync(path.join(home, 'reports'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'config.json'))).toBe(true);
    const today = JSON.parse(run(['today', '--json']).stdout);
    expect(today.sessions).toHaveLength(0);

    expect(run(['reset', '--all', '--yes']).code).toBe(0);
    expect(fs.existsSync(home)).toBe(false);
  });
});
