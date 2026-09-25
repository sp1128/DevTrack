import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { logError } from '../logger.js';

/**
 * 在后台启动 `devtrack summarize --session <id> --quiet` 生成会话摘要。
 *
 * AI 调用可能需要几秒到几十秒，不能在 SessionEnd Hook（同步执行、有超时）里等待，
 * 所以启动一个脱离父进程的子进程，Hook 本身立即退出。
 */
export function spawnSessionSummary(sessionId: string): void {
  try {
    const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
    const child = spawn(process.execPath, [cli, 'summarize', '--session', sessionId, '--quiet'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (err) => logError('session-summary:spawn', err));
    child.unref();
  } catch (err) {
    logError('session-summary:spawn', err);
  }
}
