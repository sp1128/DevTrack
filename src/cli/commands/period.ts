import { monthRange, parseDay, parseIsoWeek, parseMonth, todayRange, weekRange, type DateRange } from '../../core/time.js';
import { collectPeriodStats } from '../../stats/queries.js';
import { CliError, printJson, withCli } from '../context.js';
import { consumeAutoReportNotice } from '../notice.js';
import { renderPeriodSummary, renderToday } from '../render.js';
import { L } from '../../i18n.js';

export interface PeriodOptions {
  json?: boolean;
  sync?: boolean;
  last?: boolean;
  date?: string;
  week?: string;
  month?: string;
  yesterday?: boolean;
}

export async function runToday(options: PeriodOptions): Promise<void> {
  await withCli({ sync: options.sync }, ({ db, config, now }) => {
    let range: DateRange;
    let title = L('今天', 'Today');
    if (options.date) {
      const parsed = parseDay(options.date);
      if (!parsed) throw new CliError(`日期格式应为 YYYY-MM-DD：${options.date}`);
      range = parsed;
      title = L('当天', 'Day');
    } else if (options.yesterday) {
      range = todayRange(now, -1);
      title = L('昨天', 'Yesterday');
    } else {
      range = todayRange(now);
    }
    const stats = collectPeriodStats(db, range, { idleMinutes: config.activity.idleMinutes, prices: config.usage.prices });
    if (options.json) printJson(stats);
    else process.stdout.write(renderToday(stats, title) + consumeAutoReportNotice(db));
  });
}

export async function runWeek(options: PeriodOptions): Promise<void> {
  await withCli({ sync: options.sync }, ({ db, config, now }) => {
    let range: DateRange;
    if (options.week) {
      const parsed = parseIsoWeek(options.week);
      if (!parsed) throw new CliError(`周格式应为 YYYY-Www，例如 2026-W39：${options.week}`);
      range = parsed;
    } else {
      range = weekRange(now, options.last ? -1 : 0);
    }
    const stats = collectPeriodStats(db, range, { idleMinutes: config.activity.idleMinutes, prices: config.usage.prices });
    if (options.json) printJson(stats);
    else {
      const text = renderPeriodSummary(
        stats,
        options.last ? L('上周', 'Last week') : options.week ? L('周', 'Week') : L('本周', 'This week'),
        false,
      );
      process.stdout.write(text + consumeAutoReportNotice(db));
    }
  });
}

export async function runMonth(options: PeriodOptions): Promise<void> {
  await withCli({ sync: options.sync }, ({ db, config, now }) => {
    let range: DateRange;
    if (options.month) {
      const parsed = parseMonth(options.month);
      if (!parsed) throw new CliError(`月份格式应为 YYYY-MM：${options.month}`);
      range = parsed;
    } else {
      range = monthRange(now, options.last ? -1 : 0);
    }
    const stats = collectPeriodStats(db, range, {
      idleMinutes: config.activity.idleMinutes,
      prices: config.usage.prices,
      topFiles: 15,
    });
    if (options.json) printJson(stats);
    else {
      const title = options.last ? L('上月', 'Last month') : options.month ? L('月', 'Month') : L('本月', 'This month');
      process.stdout.write(renderPeriodSummary(stats, title, true));
    }
  });
}
