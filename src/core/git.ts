import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { normalizePath } from '../paths.js';
import { sanitizeRemoteUrl } from './redact.js';

const GIT_TIMEOUT_MS = 5000;

/**
 * 执行 git 命令，失败时返回 null（不抛错）。
 * GIT_OPTIONAL_LOCKS=0：git status 不写 index，避免和用户正在执行的 git 命令争抢 index.lock。
 */
export function runGit(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): string | null {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=off', '-c', 'log.showSignature=false', ...args], {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    });
  } catch {
    return null;
  }
}

export function gitVersion(): string | null {
  const out = runGit(process.cwd(), ['--version']);
  return out ? out.trim() : null;
}

/** 当前工作区（worktree）的根目录。 */
export function getWorkTreeRoot(cwd: string): string | null {
  const out = runGit(cwd, ['rev-parse', '--show-toplevel']);
  return out && out.trim() ? normalizePath(out.trim()) : null;
}

/**
 * 仓库主目录：对 git worktree 返回主仓库的目录，
 * 这样在 worktree 中运行的 Claude 会话也归属到同一个项目。
 */
export function getMainRepoRoot(cwd: string, workTreeRoot: string): string {
  const out = runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (out && out.trim()) {
    const commonDir = path.resolve(out.trim());
    if (path.basename(commonDir) === '.git') return normalizePath(path.dirname(commonDir));
  }
  return workTreeRoot;
}

export function getRemoteUrl(root: string): string | null {
  let out = runGit(root, ['remote', 'get-url', 'origin']);
  if (!out) {
    const remotes = runGit(root, ['remote']);
    const first = remotes?.split('\n').find((r) => r.trim());
    if (first) out = runGit(root, ['remote', 'get-url', first.trim()]);
  }
  return out && out.trim() ? sanitizeRemoteUrl(out.trim()) : null;
}

export function getCurrentBranch(root: string): string | null {
  const out = runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = out?.trim();
  if (!branch) return null;
  if (branch === 'HEAD') {
    const sha = runGit(root, ['rev-parse', '--short', 'HEAD'])?.trim();
    return sha ? `(detached ${sha})` : null;
  }
  return branch;
}

export function getUserEmail(root: string): string | null {
  const out = runGit(root, ['config', 'user.email']);
  return out && out.trim() ? out.trim() : null;
}

export interface GitCommitInfo {
  hash: string;
  branch: string | null;
  author: string;
  timestamp: string;
  message: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

const RS = '\x1e';
const US = '\x1f';

/** 读取指定时间之后的提交（所有本地分支，不含 merge 提交），附带文件与行数统计。 */
export function readCommits(root: string, options: { since: Date; authorEmail?: string | null }): GitCommitInfo[] | null {
  const args = [
    'log',
    '--branches',
    '--source',
    '--no-merges',
    '--no-color',
    '--numstat',
    `--since=${options.since.toISOString()}`,
    `--format=${RS}%H${US}%S${US}%an${US}%aI${US}%s`,
  ];
  if (options.authorEmail) args.push('--fixed-strings', `--author=<${options.authorEmail}>`);
  const out = runGit(root, args, 15_000);
  if (out === null) return null;
  const commits: GitCommitInfo[] = [];
  for (const chunk of out.split(RS)) {
    if (!chunk.trim()) continue;
    const [header, ...lines] = chunk.split('\n');
    const [hash, source, author, date, ...subject] = header!.split(US);
    if (!hash || !date) continue;
    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;
    for (const line of lines) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
      if (!m) continue;
      filesChanged++;
      if (m[1] !== '-') insertions += Number(m[1]);
      if (m[2] !== '-') deletions += Number(m[2]);
    }
    const ts = new Date(date);
    if (Number.isNaN(ts.getTime())) continue;
    commits.push({
      hash,
      branch: source ? source.replace(/^refs\/(?:heads|remotes)\//, '') : null,
      author: author ?? '',
      timestamp: ts.toISOString(),
      message: subject.join(US).trim(),
      filesChanged,
      insertions,
      deletions,
    });
  }
  return commits;
}

/** 超过这个条目数的工作区（例如未忽略 node_modules）不做快照对比。 */
export const MAX_STATUS_ENTRIES = 3000;

/**
 * 读取工作区状态快照：{ 相对路径: 两位状态码 }。
 * 返回 null 表示不是 git 仓库、执行失败或条目过多。
 */
export function readStatusSnapshot(root: string): Record<string, string> | null {
  const out = runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all']);
  if (out === null) return null;
  const snapshot: Record<string, string> = {};
  const parts = out.split('\0');
  let count = 0;
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    snapshot[file] = code;
    // 重命名 / 复制条目后面紧跟原路径，跳过
    if (code[0] === 'R' || code[0] === 'C') i++;
    if (++count > MAX_STATUS_ENTRIES) return null;
  }
  return snapshot;
}

/** 把 git status 状态码转换为文件动作。 */
export function statusCodeToAction(code: string): 'create' | 'modify' | 'delete' | 'rename' {
  if (code === '??' || code.includes('A')) return 'create';
  if (code.includes('D')) return 'delete';
  if (code.includes('R')) return 'rename';
  return 'modify';
}
