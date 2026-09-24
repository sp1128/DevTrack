import { formatZodError, loadConfigSafe } from '../config.js';
import { openDatabase, type DB } from '../db/database.js';
import { logError, writeLog } from '../logger.js';
import { getPaths } from '../paths.js';
import { handleHookEvent } from './handler.js';
import { HookInputSchema } from './schema.js';

/** 单次 Hook 处理的最长时间，超时直接退出（仍然是 0），绝不拖住 Claude Code。 */
const HOOK_DEADLINE_MS = 8000;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;

function readStdin(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    stream.on('data', (chunk: Buffer | string) => {
      if (tooLarge) return;
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buf);
    });
    stream.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

/**
 * `devtrack hook` 的入口：Claude Code 通过 stdin 传入事件 JSON。
 *
 * 约定（保证 Tracker 出错不影响 Claude Code）：
 * - 永远以退出码 0 结束，永不输出 exit 2（exit 2 会阻塞 Claude 的操作）；
 * - 不向 stdout 输出任何内容（SessionStart / UserPromptSubmit 的 stdout 会进入 Claude 的上下文）；
 * - 所有异常写入 ~/.devtrack/logs/devtrack.log。
 */
export async function runHook(stdin: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin): Promise<void> {
  const watchdog = setTimeout(() => {
    writeLog('warn', 'hook', `处理超过 ${HOOK_DEADLINE_MS}ms，已放弃本次事件`);
    process.exit(0);
  }, HOOK_DEADLINE_MS);
  watchdog.unref();

  let db: DB | undefined;
  let eventName = 'unknown';
  try {
    if (process.env.DEVTRACK_DISABLE === '1') return;
    if (stdin.isTTY) {
      process.stderr.write('devtrack hook 由 Claude Code 自动调用，事件 JSON 通过 stdin 传入。\n');
      return;
    }
    const raw = await readStdin(stdin, MAX_INPUT_BYTES);
    if (raw === null) {
      writeLog('warn', 'hook', `输入超过 ${MAX_INPUT_BYTES} 字节，已跳过`);
      return;
    }
    if (!raw.trim()) return;
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      writeLog('error', 'hook', 'stdin 不是合法的 JSON，已跳过');
      return;
    }
    const parsed = HookInputSchema.safeParse(payload);
    if (!parsed.success) {
      writeLog('error', 'hook', `输入缺少必要字段：${formatZodError(parsed.error)}`);
      return;
    }
    eventName = parsed.data.hook_event_name;
    const { config, error } = loadConfigSafe();
    if (error) logError('config', error);
    if (!config.enabled) return;
    db = openDatabase(getPaths().dbFile);
    handleHookEvent({ db, config, now: new Date() }, parsed.data);
  } catch (err) {
    logError(`hook:${eventName}`, err);
  } finally {
    try {
      db?.close();
    } catch {
      // 忽略
    }
    clearTimeout(watchdog);
    process.exitCode = 0;
  }
}
