import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncAllProjects } from '../src/core/gitSync.js';
import type { DB } from '../src/db/database.js';
import { commitFile, createRepo, git, makeTempDir, memoryDb, rmrf, rows, send, testConfig } from './helpers.js';

describe('多个 Git 作者邮箱', () => {
  let dir: string;
  let repo: string;
  let db: DB;

  const commitAs = (file: string, email: string, message: string) => {
    commitFile(repo, file, `${file}\n`, message);
    git(repo, ['commit', '--amend', '-q', '--no-edit', '--author', `Someone <${email}>`]);
  };
  const messages = () => rows<{ message: string }>(db, 'SELECT message FROM git_commits').map((r) => r.message).sort();

  beforeEach(() => {
    dir = makeTempDir();
    repo = createRepo(path.join(dir, 'app'), 'dev@example.com');
    commitAs('a.txt', 'Dev@Example.com', 'feat: 仓库邮箱（大小写不同）');
    commitAs('b.txt', 'me@work.example', 'feat: 公司邮箱');
    commitAs('c.txt', 'other@example.com', 'feat: 其他人');
    db = memoryDb();
    // 通过一次 Hook 事件让项目进入数据库
    send(db, testConfig((c) => (c.collect.git = false)), { session_id: 's', hook_event_name: 'SessionStart', cwd: repo });
  });

  afterEach(() => {
    db.close();
    rmrf(dir);
  });

  it('默认只统计仓库 user.email 的提交，且不区分大小写', () => {
    syncAllProjects(db, testConfig(), new Date());
    expect(messages()).toEqual(['chore: init', 'feat: 仓库邮箱（大小写不同）']);
  });

  it('authorEmails 中的邮箱也算作自己的提交', () => {
    syncAllProjects(db, testConfig((c) => (c.git.authorEmails = ['ME@work.example'])), new Date());
    expect(messages()).toEqual(['chore: init', 'feat: 仓库邮箱（大小写不同）', 'feat: 公司邮箱']);
  });

  it('修改邮箱配置后自动重新扫描，补上之前被过滤的提交', () => {
    const now = new Date();
    syncAllProjects(db, testConfig(), now);
    expect(messages()).not.toContain('feat: 公司邮箱');
    // 马上再次同步（通常会被 60 秒节流跳过），但配置变了，应当立即重新扫描
    syncAllProjects(db, testConfig((c) => (c.git.authorEmails = ['me@work.example'])), new Date(now.getTime() + 1000));
    expect(messages()).toContain('feat: 公司邮箱');
    expect(messages()).not.toContain('feat: 其他人');
  });

  it('authorOnly = false 时统计所有人', () => {
    syncAllProjects(db, testConfig((c) => (c.git.authorOnly = false)), new Date());
    expect(messages()).toContain('feat: 其他人');
  });
});
