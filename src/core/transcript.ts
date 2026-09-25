import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/database.js';

/**
 * 从 Claude Code 会话记录（transcript，JSONL）中增量读取 token 用量。
 *
 * 隐私：只解析 type = "assistant" 的记录，只取 message.id / model / usage 与时间戳，
 * 对话内容（message.content 等）不会被读取到数据库中。
 * 一次 API 响应可能拆成多行记录（相同 message.id、相同 usage），按 message.id 去重。
 */

export interface UsageRecord {
  messageId: string;
  model: string | null;
  timestamp: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

type Json = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** 解析一行记录，非助手消息或没有 usage 时返回 null。 */
export function parseUsageLine(line: string): UsageRecord | null {
  // 快速过滤：绝大多数行（用户消息、附件等）不需要 JSON 解析
  if (!line.includes('"assistant"') || !line.includes('"usage"')) return null;
  let entry: Json;
  try {
    entry = JSON.parse(line) as Json;
  } catch {
    return null;
  }
  if (entry.type !== 'assistant') return null;
  const message = entry.message as Json | undefined;
  const usage = message?.usage as Json | undefined;
  const id = message?.id;
  if (!usage || typeof id !== 'string') return null;
  const timestamp = typeof entry.timestamp === 'string' && !Number.isNaN(Date.parse(entry.timestamp)) ? entry.timestamp : null;
  if (!timestamp) return null;
  const cacheCreation = usage.cache_creation as Json | undefined;
  let write5m = num(cacheCreation?.ephemeral_5m_input_tokens);
  let write1h = num(cacheCreation?.ephemeral_1h_input_tokens);
  // 没有按时长拆分时，全部按 5 分钟缓存计算
  if (write5m + write1h === 0) write5m = num(usage.cache_creation_input_tokens);
  return {
    messageId: id,
    model: typeof message?.model === 'string' ? message.model : null,
    timestamp: new Date(timestamp).toISOString(),
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
  };
}

/** 会话记录及其子代理记录文件（<记录目录>/<会话 ID>/subagents/*.jsonl）。 */
export function transcriptFiles(transcriptPath: string): string[] {
  const files = [transcriptPath];
  const subDir = path.join(path.dirname(transcriptPath), path.basename(transcriptPath, '.jsonl'), 'subagents');
  try {
    for (const name of fs.readdirSync(subDir)) {
      if (name.endsWith('.jsonl')) files.push(path.join(subDir, name));
    }
  } catch {
    // 没有子代理记录
  }
  return files;
}

/** 单次最多读取的字节数，防止超大文件拖慢 Hook。剩余部分下次继续读。 */
const MAX_READ_BYTES = 32 * 1024 * 1024;

/**
 * 从上次读取的位置继续读取文件，返回新的完整行与新的偏移量。
 * 末尾不完整的一行（Claude Code 仍在写入）留到下次读取。
 */
export function readNewLines(file: string, offset: number): { lines: string[]; offset: number } | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    // 文件被截断或重写时从头读取
    const start = offset > size ? 0 : offset;
    const length = Math.min(size - start, MAX_READ_BYTES);
    if (length <= 0) return { lines: [], offset: start };
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    const lastNewline = buf.lastIndexOf(0x0a);
    // 单行超过读取上限（不可能是用量记录）时直接跳过，避免卡在这一行
    if (lastNewline < 0) return { lines: [], offset: length === MAX_READ_BYTES ? start + length : start };
    const text = buf.subarray(0, lastNewline).toString('utf8');
    return { lines: text.split('\n'), offset: start + lastNewline + 1 };
  } finally {
    fs.closeSync(fd);
  }
}

/** 增量导入会话记录中的 token 用量，返回新增的消息数。 */
export function ingestTranscript(
  db: DB,
  transcriptPath: string,
  ids: { sessionId: number; projectId: number },
  now: Date,
): number {
  let added = 0;
  const getOffset = db.prepare('SELECT offset FROM transcript_offsets WHERE file = ?');
  const setOffset = db.prepare(
    `INSERT INTO transcript_offsets (file, offset, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(file) DO UPDATE SET offset = excluded.offset, updated_at = excluded.updated_at`,
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO token_usage
       (session_id, project_id, message_id, model, timestamp,
        input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const file of transcriptFiles(transcriptPath)) {
    const row = getOffset.get(file) as { offset: number } | undefined;
    const chunk = readNewLines(file, row?.offset ?? 0);
    if (!chunk) continue;
    db.transaction(() => {
      for (const line of chunk.lines) {
        const u = parseUsageLine(line);
        if (!u) continue;
        const r = insert.run(
          ids.sessionId,
          ids.projectId,
          u.messageId,
          u.model,
          u.timestamp,
          u.input,
          u.output,
          u.cacheRead,
          u.cacheWrite5m,
          u.cacheWrite1h,
        );
        added += r.changes;
      }
      setOffset.run(file, chunk.offset, now.toISOString());
    })();
  }
  return added;
}
