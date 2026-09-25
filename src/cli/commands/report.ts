import fs from 'node:fs';
import path from 'node:path';
import { monthRange, parseIsoWeek, parseMonth, weekRange, type DateRange } from '../../core/time.js';
import { setMeta } from '../../db/purge.js';
import { logError } from '../../logger.js';
import { AiError, buildAiPayload, generateAiSummary, resolveModel } from '../../report/ai.js';
import { buildWeeklyReport, type ReportPeriod } from '../../report/weekly.js';
import { tildify } from '../../paths.js';
import { collectPeriodStats } from '../../stats/queries.js';
import { CliError, printJson, withCli } from '../context.js';
import { c } from '../format.js';
import { AUTO_REPORT_NOTICE_KEY } from '../notice.js';

export interface ReportCommandOptions {
  week?: string;
  /** --month 不带值时为 true，表示本月（与 --last 一起表示上月） */
  month?: string | boolean;
  last?: boolean;
  ai?: boolean;
  dryRun?: boolean;
  output?: string;
  stdout?: boolean;
  sync?: boolean;
  /** 由 Hook 在每周第一次会话时自动调用：静默、不覆盖已有文件、没有数据时不生成 */
  auto?: boolean;
}

export async function runReport(options: ReportCommandOptions): Promise<void> {
  if (!options.auto) return generateReport(options);
  try {
    await generateReport(options);
  } catch (err) {
    logError('auto-report', err);
  }
}

function resolveRange(options: ReportCommandOptions, now: Date): { range: DateRange; period: ReportPeriod } {
  if (options.month !== undefined && options.month !== false) {
    if (options.week) throw new CliError('--week 与 --month 不能同时使用');
    if (typeof options.month === 'string') {
      const parsed = parseMonth(options.month);
      if (!parsed) throw new CliError(`月份格式应为 YYYY-MM：${options.month}`);
      return { range: parsed, period: 'month' };
    }
    return { range: monthRange(now, options.last ? -1 : 0), period: 'month' };
  }
  if (options.week) {
    const parsed = parseIsoWeek(options.week);
    if (!parsed) throw new CliError(`周格式应为 YYYY-Www，例如 2026-W39：${options.week}`);
    return { range: parsed, period: 'week' };
  }
  return { range: weekRange(now, options.last ? -1 : 0), period: 'week' };
}

async function generateReport(options: ReportCommandOptions): Promise<void> {
  await withCli({ sync: options.sync }, async ({ db, config, paths, now }) => {
    const { range, period } = resolveRange(options, now);
    const target = options.output ? path.resolve(options.output) : path.join(paths.reportsDir, `${range.label}.md`);
    if (options.auto && fs.existsSync(target)) return;

    const stats = collectPeriodStats(db, range, {
      idleMinutes: config.activity.idleMinutes,
      prices: config.usage.prices,
      topFiles: 15,
    });
    if (options.auto && stats.sessions.length === 0 && stats.commits.length === 0) return;

    const useAi = options.ai || (options.auto && config.report.autoAi);
    if (useAi && options.dryRun) {
      console.error(c.gray(`以下数据将发送给 ${config.ai.provider}（模型 ${safeModel(config)}），未实际发送：`));
      printJson(buildAiPayload(stats, config));
      return;
    }

    let aiSummary: { text: string; provider: string; model: string } | undefined;
    let aiError: string | undefined;
    if (useAi) {
      if (!options.auto) {
        console.error(c.gray(`正在调用 ${config.ai.provider} 生成 AI 总结（只发送统计数据，不发送源代码）…`));
      }
      try {
        aiSummary = await generateAiSummary(stats, config, {}, period);
      } catch (err) {
        aiError = err instanceof AiError ? err.message : (err as Error).message;
        if (options.auto) logError('auto-report:ai', err);
        else console.error(c.yellow(`AI 总结生成失败：${aiError}`));
      }
    }

    const markdown = buildWeeklyReport(stats, { generatedAt: now, aiSummary, aiError, period });
    if (options.stdout) {
      process.stdout.write(markdown);
      return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, markdown, 'utf8');
    if (options.auto) {
      setMeta(db, AUTO_REPORT_NOTICE_KEY, target);
      return;
    }
    console.log(`${c.green('✔')} ${period === 'week' ? '周报' : '月报'}已生成：${tildify(target)}`);
  });
}

function safeModel(config: Parameters<typeof resolveModel>[0]): string {
  try {
    return resolveModel(config);
  } catch {
    return '未设置';
  }
}
