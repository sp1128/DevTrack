import fs from 'node:fs';
import path from 'node:path';
import { parseIsoWeek, weekRange, type DateRange } from '../../core/time.js';
import { AiError, buildAiPayload, generateAiSummary, resolveModel } from '../../report/ai.js';
import { buildWeeklyReport } from '../../report/weekly.js';
import { tildify } from '../../paths.js';
import { collectPeriodStats } from '../../stats/queries.js';
import { CliError, printJson, withCli } from '../context.js';
import { c } from '../format.js';

export interface ReportCommandOptions {
  week?: string;
  last?: boolean;
  ai?: boolean;
  dryRun?: boolean;
  output?: string;
  stdout?: boolean;
  sync?: boolean;
}

export async function runReport(options: ReportCommandOptions): Promise<void> {
  await withCli({ sync: options.sync }, async ({ db, config, paths, now }) => {
    let range: DateRange;
    if (options.week) {
      const parsed = parseIsoWeek(options.week);
      if (!parsed) throw new CliError(`周格式应为 YYYY-Www，例如 2026-W39：${options.week}`);
      range = parsed;
    } else {
      range = weekRange(now, options.last ? -1 : 0);
    }
    const stats = collectPeriodStats(db, range, {
      idleMinutes: config.activity.idleMinutes,
      prices: config.usage.prices,
      topFiles: 15,
    });

    if (options.ai && options.dryRun) {
      console.error(c.gray(`以下数据将发送给 ${config.ai.provider}（模型 ${safeModel(config)}），未实际发送：`));
      printJson(buildAiPayload(stats, config));
      return;
    }

    let aiSummary: { text: string; provider: string; model: string } | undefined;
    let aiError: string | undefined;
    if (options.ai) {
      console.error(c.gray(`正在调用 ${config.ai.provider} 生成 AI 总结（只发送统计数据，不发送源代码）…`));
      try {
        aiSummary = await generateAiSummary(stats, config);
      } catch (err) {
        aiError = err instanceof AiError ? err.message : (err as Error).message;
        console.error(c.yellow(`AI 总结生成失败：${aiError}`));
      }
    }

    const markdown = buildWeeklyReport(stats, { generatedAt: now, aiSummary, aiError });
    if (options.stdout) {
      process.stdout.write(markdown);
      return;
    }
    const target = options.output ? path.resolve(options.output) : path.join(paths.reportsDir, `${stats.range.label}.md`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, markdown, 'utf8');
    console.log(`${c.green('✔')} 周报已生成：${tildify(target)}`);
  });
}

function safeModel(config: Parameters<typeof resolveModel>[0]): string {
  try {
    return resolveModel(config);
  } catch {
    return '未设置';
  }
}
