import os from 'node:os';
import path from 'node:path';
import { normalizePath } from '../paths.js';
import { getCurrentBranch, getMainRepoRoot, getRemoteUrl, getWorkTreeRoot } from './git.js';

export interface DetectedProject {
  /** 项目名：仓库（或目录）名，例如 project-a */
  name: string;
  /** 项目路径（项目的唯一标识）：git 仓库主目录，非 git 项目为 cwd */
  path: string;
  /** 当前工作区根目录（git worktree 时与 path 不同） */
  workRoot: string;
  gitRemote: string | null;
  gitBranch: string | null;
  isGit: boolean;
}

/**
 * 根据 Claude Code 的 cwd 自动识别项目，无需手动注册：
 * - 在 git 仓库内（包括子目录、worktree）时，项目 = 仓库主目录；
 * - 否则项目 = cwd 本身。
 */
export function detectProject(cwd: string): DetectedProject {
  const resolved = normalizePath(cwd);
  const workTreeRoot = getWorkTreeRoot(resolved);
  if (workTreeRoot) {
    const mainRoot = getMainRepoRoot(resolved, workTreeRoot);
    return {
      name: path.basename(mainRoot) || mainRoot,
      path: mainRoot,
      workRoot: workTreeRoot,
      gitRemote: getRemoteUrl(workTreeRoot),
      gitBranch: getCurrentBranch(workTreeRoot),
      isGit: true,
    };
  }
  return {
    name: path.basename(resolved) || resolved,
    path: resolved,
    workRoot: resolved,
    gitRemote: null,
    gitBranch: null,
    isGit: false,
  };
}

/** 判断项目是否在排除列表中（按项目名或路径前缀匹配）。 */
export function isProjectExcluded(project: { name: string; path: string }, exclude: string[]): boolean {
  if (exclude.length === 0) return false;
  const projectPath = normalizePath(project.path);
  const cmpPath = process.platform === 'win32' ? projectPath.toLowerCase() : projectPath;
  for (const raw of exclude) {
    const entry = raw.trim();
    if (!entry) continue;
    if (!entry.includes('/') && !entry.includes('\\')) {
      if (entry.toLowerCase() === project.name.toLowerCase()) return true;
      continue;
    }
    let prefix = normalizePath(entry.startsWith('~') ? path.join(os.homedir(), entry.slice(1)) : entry);
    if (process.platform === 'win32') prefix = prefix.toLowerCase();
    if (cmpPath === prefix || cmpPath.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')) return true;
  }
  return false;
}

/**
 * 把文件绝对路径转换为相对项目的路径；项目外的文件保留绝对路径。
 */
export function relativizePath(filePath: string, roots: string[]): { path: string; inside: boolean } {
  const abs = normalizePath(filePath);
  const cmp = process.platform === 'win32' ? abs.toLowerCase() : abs;
  for (const root of roots) {
    if (!root) continue;
    const r = normalizePath(root);
    const rc = process.platform === 'win32' ? r.toLowerCase() : r;
    if (cmp === rc) return { path: '.', inside: true };
    if (cmp.startsWith(rc.endsWith('/') ? rc : rc + '/')) {
      return { path: abs.slice(r.length).replace(/^[/\\]+/, '').replace(/\\/g, '/'), inside: true };
    }
  }
  return { path: abs, inside: false };
}
