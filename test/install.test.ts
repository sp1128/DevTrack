import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HOOK_MARKER,
  inspectHooks,
  installHooks,
  isDevTrackHandler,
  SettingsError,
  uninstallHooks,
} from '../src/hooks/install.js';
import { HOOK_EVENTS } from '../src/hooks/schema.js';
import { makeTempDir, rmrf } from './helpers.js';

describe('Hook 安装', () => {
  let dir: string;
  let settingsPath: string;
  let backupDir: string;
  const cliPath = '/opt/devtrack/dist/cli.js';
  const nodePath = '/usr/bin/node';

  beforeEach(() => {
    dir = makeTempDir();
    settingsPath = path.join(dir, 'claude', 'settings.json');
    backupDir = path.join(dir, 'backups');
  });
  afterEach(() => rmrf(dir));

  const read = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  it('settings.json 不存在时创建，并注册全部事件', () => {
    const result = installHooks({ settingsPath, backupDir, cliPath, nodePath });
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeUndefined();
    const settings = read();
    expect(Object.keys(settings.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    const post = settings.hooks.PostToolUse[0];
    expect(post.matcher).toBe('*');
    expect(post.hooks[0]).toEqual({
      type: 'command',
      command: nodePath,
      args: [cliPath, 'hook', HOOK_MARKER],
      async: true,
    });
    // SessionEnd 同步执行，并提高超时预算
    expect(settings.hooks.SessionEnd[0].hooks[0]).toMatchObject({ timeout: 5 });
    expect(settings.hooks.SessionEnd[0].hooks[0].async).toBeUndefined();
    // 不支持 matcher 的事件不写 matcher
    expect(settings.hooks.Stop[0].matcher).toBeUndefined();
  });

  it('保留用户已有的配置与 Hook，并备份原文件', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const original = {
      model: 'opus',
      permissions: { allow: ['Skill'] },
      hooks: {
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: '~/.claude/stop-hook.sh' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(original));
    const result = installHooks({ settingsPath, backupDir, cliPath, nodePath });
    expect(result.backupPath && fs.existsSync(result.backupPath)).toBe(true);
    const settings = read();
    expect(settings.model).toBe('opus');
    expect(settings.permissions).toEqual({ allow: ['Skill'] });
    expect(settings.hooks.PreToolUse).toEqual(original.hooks.PreToolUse);
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.Stop[0]).toEqual(original.hooks.Stop[0]);
  });

  it('重复安装是幂等的；卸载后恢复原样', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const original = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } };
    fs.writeFileSync(settingsPath, JSON.stringify(original));
    installHooks({ settingsPath, backupDir, cliPath, nodePath });
    const once = read();
    const second = installHooks({ settingsPath, backupDir, cliPath, nodePath });
    expect(second.changed).toBe(false);
    expect(read()).toEqual(once);
    // 换了 node / cli 路径后重装，旧的 DevTrack Hook 被替换而不是重复
    installHooks({ settingsPath, backupDir, cliPath: '/new/cli.js', nodePath });
    const updated = read();
    expect(updated.hooks.SessionStart).toHaveLength(1);
    expect(updated.hooks.SessionStart[0].hooks[0].args[0]).toBe('/new/cli.js');

    const removed = uninstallHooks({ settingsPath, backupDir });
    expect(removed.removed).toBe(HOOK_EVENTS.length);
    expect(read()).toEqual(original);
  });

  it('PATH 模式使用 shell 形式的命令', () => {
    installHooks({ settingsPath, backupDir, mode: 'path' });
    const handler = read().hooks.SessionStart[0].hooks[0];
    expect(handler.command).toBe(`devtrack hook ${HOOK_MARKER}`);
    expect(handler.args).toBeUndefined();
    expect(isDevTrackHandler(handler)).toBe(true);
    expect(isDevTrackHandler({ type: 'command', command: 'other hook' })).toBe(false);
  });

  it('可选地启用任务工具环境变量', () => {
    installHooks({ settingsPath, backupDir, cliPath, nodePath, enableTaskTools: true });
    expect(read().env).toEqual({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' });
    expect(inspectHooks(settingsPath).taskToolsEnabled).toBe(true);
  });

  it('settings.json 格式错误时拒绝写入，不覆盖用户文件', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{ "hooks": ');
    expect(() => installHooks({ settingsPath, backupDir, cliPath, nodePath })).toThrow(SettingsError);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ "hooks": ');
  });

  it('inspectHooks 报告缺失事件、失效路径与 disableAllHooks', () => {
    expect(inspectHooks(settingsPath).installed).toEqual([]);
    const realCli = path.join(dir, 'cli.js');
    fs.writeFileSync(realCli, '');
    installHooks({ settingsPath, backupDir, cliPath: realCli, nodePath: process.execPath });
    let info = inspectHooks(settingsPath);
    expect(info.missing).toEqual([]);
    expect(info.problems).toEqual([]);
    expect(info.mode).toBe('node');

    const settings = read();
    delete settings.hooks.Stop;
    settings.disableAllHooks = true;
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    fs.rmSync(realCli);
    info = inspectHooks(settingsPath);
    expect(info.missing).toEqual(['Stop']);
    expect(info.disableAllHooks).toBe(true);
    expect(info.problems.join()).toContain(realCli);
  });
});
