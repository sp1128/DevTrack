import fs from 'node:fs';
import type { DevTrackConfig } from '../config.js';
import type { DB } from '../db/database.js';
import {
  getGitState,
  insertCommit,
  insertFileChange,
  listProjects,
  sessionHasFileChange,
  setGitState,
  setProjectScanTime,
  type ProjectRow,
  type SessionRow,
} from '../db/repo.js';
import { getMeta, setMeta } from '../db/purge.js';
import { logError } from '../logger.js';
import { getUserEmail, readCommits, readStatusSnapshot, statusCodeToAction } from './git.js';
import { sanitizeText } from './text.js';

const DAY_MS = 24 * 3600 * 1000;

export interface SyncOptions {
  /** 距离上次扫描不足该秒数时跳过（Stop 事件频繁，做节流）。 */
  minIntervalSeconds?: number;
}

/** 用于过滤提交的作者邮箱：仓库的 user.email + git.authorEmails；authorOnly 关闭时不过滤。 */
export function resolveAuthorEmails(project: ProjectRow, config: DevTrackConfig): string[] {
  if (!config.git.authorOnly) return [];
  const emails = [getUserEmail(project.path), ...config.git.authorEmails]
    .filter((e): e is string => !!e && !!e.trim())
    .map((e) => e.trim().toLowerCase());
  return [...new Set(emails)];
}

const AUTHOR_FILTER_KEY = 'git_author_filter';

/**
 * 作者过滤条件（authorOnly / authorEmails）变化后，清空各项目的扫描时间，
 * 下次同步时按 backfillDays 重新扫描，补上之前被过滤掉的提交（已有提交按 hash 去重）。
 */
export function refreshOnAuthorFilterChange(db: DB, config: DevTrackConfig): boolean {
  const current = JSON.stringify({
    authorOnly: config.git.authorOnly,
    emails: [...config.git.authorEmails].map((e) => e.trim().toLowerCase()).sort(),
  });
  const previous = getMeta(db, AUTHOR_FILTER_KEY);
  if (previous === current) return false;
  db.transaction(() => {
    // 首次记录时不需要重扫
    if (previous !== undefined) db.prepare('UPDATE projects SET last_git_scan_at = NULL').run();
    setMeta(db, AUTHOR_FILTER_KEY, current);
  })();
  return previous !== undefined;
}

/**
 * 增量读取项目的 Git 提交并写入数据库。
 * 首次扫描回溯 git.backfillDays 天；之后从上次扫描时间往前 1 天开始（按 hash 去重）。
 */
export function syncProjectCommits(
  db: DB,
  project: ProjectRow,
  config: DevTrackConfig,
  now: Date,
  options: SyncOptions = {},
): { added: number } | null {
  if (!config.collect.git || !project.is_git) return null;
  const last = project.last_git_scan_at ? Date.parse(project.last_git_scan_at) : NaN;
  if (options.minIntervalSeconds && !Number.isNaN(last) && now.getTime() - last < options.minIntervalSeconds * 1000) {
    return null;
  }
  if (!fs.existsSync(project.path)) return null;
  const since = Number.isNaN(last)
    ? new Date(now.getTime() - config.git.backfillDays * DAY_MS)
    : new Date(last - DAY_MS);
  const commits = readCommits(project.path, { since, authorEmails: resolveAuthorEmails(project, config) });
  if (commits === null) return null;
  let added = 0;
  const extra = config.privacy.redactPatterns;
  db.transaction(() => {
    for (const c of commits) {
      const inserted = insertCommit(db, {
        projectId: project.id,
        hash: c.hash,
        branch: c.branch,
        message: sanitizeText(c.message, 300, extra),
        author: sanitizeText(c.author, 100, extra),
        timestamp: c.timestamp,
        filesChanged: c.filesChanged,
        insertions: c.insertions,
        deletions: c.deletions,
      });
      if (inserted) added++;
    }
    setProjectScanTime(db, project.id, now.toISOString());
  })();
  project.last_git_scan_at = now.toISOString();
  return { added };
}

/** CLI 查询前同步所有已知项目的提交（查看统计时也能看到 Claude 之外的提交）。 */
export function syncAllProjects(db: DB, config: DevTrackConfig, now: Date): number {
  if (!config.collect.git) return 0;
  const refreshed = refreshOnAuthorFilterChange(db, config);
  let added = 0;
  for (const project of listProjects(db)) {
    try {
      added += syncProjectCommits(db, project, config, now, { minIntervalSeconds: refreshed ? 0 : 60 })?.added ?? 0;
    } catch (err) {
      logError(`git-sync:${project.name}`, err);
    }
  }
  return added;
}

/** 单次快照对比最多记录的文件数，防止代码生成器等场景写入大量记录。 */
const MAX_DIFF_ENTRIES = 200;

/** 记录工作区基线快照（会话开始时调用）。 */
export function snapshotBaseline(db: DB, session: SessionRow, project: ProjectRow, ts: string): void {
  const root = session.work_root ?? project.path;
  const snapshot = readStatusSnapshot(root);
  if (snapshot) setGitState(db, session.id, snapshot, ts);
}

/**
 * 对比 git status 快照，补充记录 Claude 文件工具之外产生的文件变化
 * （Bash 命令、代码生成器、用户在编辑器中的修改等）。
 * 自上次快照以来已由 Claude 工具记录过的文件不会重复记录。
 */
export function diffWorkingTree(db: DB, session: SessionRow, project: ProjectRow, ts: string): number {
  const root = session.work_root ?? project.path;
  const current = readStatusSnapshot(root);
  if (!current) return 0;
  const prev = getGitState(db, session.id);
  if (!prev) {
    setGitState(db, session.id, current, ts);
    return 0;
  }
  let recorded = 0;
  db.transaction(() => {
    for (const [file, code] of Object.entries(current)) {
      if (prev.snapshot[file] === code) continue;
      if (recorded >= MAX_DIFF_ENTRIES) break;
      if (sessionHasFileChange(db, session.id, file, prev.updatedAt)) continue;
      insertFileChange(db, {
        sessionId: session.id,
        projectId: project.id,
        filePath: file,
        action: statusCodeToAction(code),
        source: 'git',
        ts,
      });
      recorded++;
    }
    setGitState(db, session.id, current, ts);
  })();
  return recorded;
}
