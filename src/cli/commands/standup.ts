import { parseDay } from '../../core/time.js';
import { L } from '../../i18n.js';
import { AiError } from '../../report/ai.js';
import { resolveSummaryModel } from '../../report/sessionSummary.js';
import { buildStandupPayload, collectStandup, generateAiStandup, renderStandup } from '../../report/standup.js';
import { CliError, printJson, statsOptions, withCli } from '../context.js';
import { c } from '../format.js';

export interface StandupOptions {
  date?: string;
  ai?: boolean;
  dryRun?: boolean;
  json?: boolean;
  sync?: boolean;
}

export async function runStandup(options: StandupOptions): Promise<void> {
  await withCli({ sync: options.sync }, async ({ db, config, now }) => {
    let target = now;
    if (options.date) {
      const day = parseDay(options.date);
      if (!day) throw new CliError(`日期格式应为 YYYY-MM-DD：${options.date}`);
      // 指定日期时统计当天全天
      target = new Date(day.end.getTime() - 1);
    }
    const data = collectStandup(db, target, statsOptions(config));

    if (options.json) {
      printJson(buildStandupPayload(data));
      return;
    }
    if (options.ai && options.dryRun) {
      console.error(
        c.gray(
          L(
            `以下数据将发送给 ${config.ai.provider}（模型 ${resolveSummaryModel(config)}），未实际发送：`,
            `The following would be sent to ${config.ai.provider} (model ${resolveSummaryModel(config)}); nothing was sent:`,
          ),
        ),
      );
      printJson(buildStandupPayload(data));
      return;
    }
    if (options.ai) {
      try {
        const result = await generateAiStandup(data, config);
        process.stdout.write(result.text.trim() + '\n');
        return;
      } catch (err) {
        const message = err instanceof AiError ? err.message : (err as Error).message;
        console.error(c.yellow(L(`AI 生成失败，改为输出模板版本：${message}`, `AI generation failed, showing the template version: ${message}`)));
      }
    }
    process.stdout.write(renderStandup(data, now));
  });
}
