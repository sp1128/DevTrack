import { formatDateTime, parseCutoff } from '../../core/time.js';
import { logError, writeLog } from '../../logger.js';
import { AiError } from '../../report/ai.js';
import {
  buildSessionPayload,
  findSessionsToSummarize,
  resolveSummaryModel,
  summarizeSession,
} from '../../report/sessionSummary.js';
import { CliError, printJson, withCli } from '../context.js';
import { c } from '../format.js';

export interface SummarizeOptions {
  since?: string;
  session?: string;
  force?: boolean;
  limit?: string;
  dryRun?: boolean;
  quiet?: boolean;
}

export async function runSummarize(options: SummarizeOptions): Promise<void> {
  try {
    await summarize(options);
  } catch (err) {
    // Hook 自动调用时（--quiet）不输出任何内容，错误写入日志
    if (!options.quiet) throw err;
    logError('session-summary', err);
  }
}

async function summarize(options: SummarizeOptions): Promise<void> {
  const log = options.quiet ? () => {} : (line: string) => console.log(line);
  await withCli({ sync: false }, async ({ db, config, now }) => {
    // 指定会话时不限制时间
    const since = options.session ? new Date(0) : parseCutoff(options.since ?? '7d', now);
    if (!since) throw new CliError(`无法识别的时间：${options.since}（示例：7d、4w、2026-09-01）`);
    const limit = Number(options.limit ?? 20);
    if (!Number.isInteger(limit) || limit < 1) throw new CliError(`--limit 应为正整数：${options.limit}`);

    const pending = findSessionsToSummarize(db, { since, force: options.force, sessionId: options.session, limit });
    if (pending.length === 0) {
      log(c.gray(options.session ? '没有找到需要生成摘要的会话（会话不存在、仍在进行中或已有摘要）。' : '没有需要生成摘要的会话。'));
      return;
    }

    if (options.dryRun) {
      const first = pending.map((p) => ({ p, payload: buildSessionPayload(db, p.id, config) })).find((x) => x.payload);
      if (!first) {
        log(c.gray('这些会话没有可以概括的活动（没有工具调用、文件修改、提交或任务）。'));
        return;
      }
      console.error(
        c.gray(`以下是会话 ${first.p.sessionId} 将发送给 ${config.ai.provider}（模型 ${resolveSummaryModel(config)}）的数据，未实际发送：`),
      );
      printJson(first.payload);
      return;
    }

    log(c.gray(`正在调用 ${config.ai.provider}（${resolveSummaryModel(config)}）为 ${pending.length} 个会话生成摘要，只发送统计数据…`));
    let done = 0;
    let skipped = 0;
    for (const p of pending) {
      try {
        const result = await summarizeSession(db, p.id, config, now);
        if (!result) {
          skipped++;
          continue;
        }
        done++;
        log(`  ${c.green('✔')} ${c.gray(formatDateTime(new Date(p.startedAt)))} ${p.projectName}：${result.summary}`);
      } catch (err) {
        const message = err instanceof AiError ? err.message : (err as Error).message;
        if (options.quiet) writeLog('error', 'session-summary', `${p.sessionId}：${message}`);
        else console.error(c.yellow(`  ✖ ${p.projectName}（${p.sessionId}）：${message}`));
        // 认证、配置类错误对所有会话都一样，不再继续
        if (err instanceof AiError && /认证|API Key|需要指定模型|需要设置/.test(message)) break;
      }
    }
    log(
      c.gray(
        `完成：生成 ${done} 个${skipped > 0 ? `，${skipped} 个会话没有可概括的活动已跳过` : ''}。摘要会显示在 today / week / report 中。`,
      ),
    );
  });
}
