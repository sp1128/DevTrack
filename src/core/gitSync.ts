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
import { logError } from '../logger.js';
import { getUserEmail, readCommits, readStatusSnapshot, statusCodeToAction } from './git.js';
import { sanitizeText } from './text.js';

const DAY_MS = 24 * 3600 * 1000;

export interface SyncOptions {
  /** 距离上次扫描不足该秒数时跳过（Stop 事件频繁，做节流）。 */
  minIntervalSeconds?: number;
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
  const authorEmail = config.git.authorOnly ? getUserEmail(project.path) : null;
  const commits = readCommits(project.path, { since, authorEmail });
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
  let added = 0;
  for (const project of listProjects(db)) {
    try {
      added += syncProjectCommits(db, project, config, now, { minIntervalSeconds: 60 })?.added ?? 0;
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
