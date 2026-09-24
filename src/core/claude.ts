import { execFileSync } from 'node:child_process';

/** exec 形式的 Hook（args 字段）需要的最低 Claude Code 版本。 */
export const MIN_VERSION_EXEC_FORM = '2.1.139';
/** PostToolUse / PostToolUseFailure 提供 duration_ms 的最低版本。 */
export const MIN_VERSION_DURATION = '2.1.119';

export function getClaudeCodeVersion(): { version: string | null; raw: string | null } {
  try {
    const out = execFileSync('claude', ['--version'], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      // Windows 上 claude 可能是 .cmd 包装脚本，需要通过 shell 调用
      shell: process.platform === 'win32',
    }).trim();
    const match = /(\d+\.\d+\.\d+)/.exec(out);
    return { version: match ? match[1]! : null, raw: out || null };
  } catch {
    return { version: null, raw: null };
  }
}

/** 比较 a.b.c 形式的版本号：a < b 返回负数。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
