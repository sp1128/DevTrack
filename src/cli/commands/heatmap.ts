import { formatDuration } from '../../core/format.js';
import { formatDate, weekRange } from '../../core/time.js';
import { collectPeriodStats, type DailySummary } from '../../stats/queries.js';
import { CliError, printJson, withCli } from '../context.js';
import { c, color256, colorEnabled, displayWidth } from '../format.js';
import { getLang, L } from '../../i18n.js';

export type HeatmapMetric = 'time' | 'commits' | 'sessions';

export interface HeatmapOptions {
  weeks?: string;
  metric?: string;
  json?: boolean;
  sync?: boolean;
}

const METRICS: Record<HeatmapMetric, { label: () => string; value: (d: DailySummary) => number }> = {
  time: { label: () => L('开发时长', 'Active time'), value: (d) => d.activeSeconds },
  commits: { label: () => L('Git 提交', 'Git commits'), value: (d) => d.commits },
  sessions: { label: () => L('Claude 会话', 'Claude sessions'), value: (d) => d.sessions },
};

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** GitHub 风格的绿色（256 色）；0 级为灰色。 */
const LEVEL_COLORS = [238, 22, 28, 34, 46];
/** 没有颜色时使用的字符 */
const LEVEL_CHARS = ['·', '░', '▒', '▓', '█'];

/**
 * 把每天的数值分为 0–4 级：以非零值的第 90 百分位为满格参考（避免个别极端值把其他天都压成浅色），
 * 有活动的天至少为 1 级。
 */
export function computeLevels(values: number[]): number[] {
  const nonZero = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (nonZero.length === 0) return values.map(() => 0);
  const ref = nonZero[Math.min(nonZero.length - 1, Math.floor(0.9 * nonZero.length))]!;
  return values.map((v) => (v <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((v / ref) * 4)))));
}

/** 连续活跃天数：最长连续、截止到最后一天的当前连续。 */
export function streaks(active: boolean[]): { longest: number; current: number } {
  let longest = 0;
  let run = 0;
  for (const a of active) {
    run = a ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  let current = 0;
  for (let i = active.length - 1; i >= 0 && active[i]; i--) current++;
  // 今天还没有活动时，从昨天开始算当前连续
  if (current === 0 && active.length > 1) {
    for (let i = active.length - 2; i >= 0 && active[i]; i--) current++;
  }
  return { longest, current };
}

function cell(level: number): string {
  if (!colorEnabled()) return LEVEL_CHARS[level]!;
  return color256(LEVEL_COLORS[level]!, level === 0 ? '·' : '■');
}

/**
 * 渲染热力图：7 行（周一到周日）× N 列（周），每格 2 列宽。
 * daily 必须从某个周一开始、按天连续；today 之后的日期留空。
 */
export function renderHeatmap(daily: DailySummary[], metric: HeatmapMetric, today: string): string {
  const def = METRICS[metric];
  const shown = daily.filter((d) => d.date <= today);
  const levels = computeLevels(shown.map(def.value));
  const levelByDate = new Map(shown.map((d, i) => [d.date, levels[i]!]));
  const weeks = Math.ceil(daily.length / 7);

  // 月份标签：显示在每个月第一次出现的那一列上方，与上一个标签重叠时省略
  let header = '';
  let col = 0;
  let lastMonth = '';
  for (let w = 0; w < weeks; w++) {
    const month = daily[w * 7]!.date.slice(5, 7);
    if (month === lastMonth) continue;
    lastMonth = month;
    const target = 4 + w * 2;
    if (col > 0 && target <= col) continue;
    const label = getLang() === 'en' ? MONTHS_EN[Number(month) - 1]! : `${Number(month)}月`;
    header += ' '.repeat(target - col) + label;
    col = target + displayWidth(label);
  }

  const rowLabels = getLang() === 'en' ? ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'] : ['一', '', '三', '', '五', '', '日'];
  const lines = [c.gray(header.trimEnd())];
  for (let r = 0; r < 7; r++) {
    let line = rowLabels[r] ? c.gray(rowLabels[r]!.padEnd(4 - displayWidth(rowLabels[r]!) + rowLabels[r]!.length, ' ')) : '    ';
    for (let w = 0; w < weeks; w++) {
      const d = daily[w * 7 + r];
      const level = d ? levelByDate.get(d.date) : undefined;
      line += level === undefined ? '  ' : `${cell(level)} `;
    }
    lines.push(line.trimEnd());
  }
  lines.push('', `    ${c.gray(L('少', 'Less'))} ${[0, 1, 2, 3, 4].map(cell).join(' ')} ${c.gray(L('多', 'More'))}`);

  const total = shown.reduce((n, d) => n + def.value(d), 0);
  const activeDays = shown.filter((d) => d.activeSeconds > 0 || d.commits > 0).length;
  const { longest, current } = streaks(shown.map((d) => d.activeSeconds > 0 || d.commits > 0));
  const totalText = metric === 'time' ? formatDuration(total) : L(`${total} ${metric === 'commits' ? '次' : '个'}`, String(total));
  lines.push(
    '',
    L(
      `  ${def.label()} ${c.bold(totalText)} · 活跃 ${c.bold(String(activeDays))} 天 · 最长连续 ${longest} 天 · 当前连续 ${current} 天`,
      `  ${def.label()} ${c.bold(totalText)} · ${c.bold(String(activeDays))} active days · longest streak ${longest} days · current streak ${current} days`,
    ),
  );
  return lines.join('\n') + '\n';
}

export async function runHeatmap(options: HeatmapOptions): Promise<void> {
  const metric = (options.metric ?? 'time') as HeatmapMetric;
  if (!(metric in METRICS)) throw new CliError(`--metric 只支持 time / commits / sessions：${options.metric}`);
  let weeks: number;
  if (options.weeks !== undefined) {
    weeks = Number(options.weeks);
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 156) throw new CliError(`--weeks 应为 1–156 的整数：${options.weeks}`);
  } else {
    // 默认最近一年，按终端宽度自动缩减（每周 2 列，另有 4 列行标签）
    const columns = process.stdout.columns || 120;
    weeks = Math.max(4, Math.min(53, Math.floor((columns - 5) / 2)));
  }

  await withCli({ sync: options.sync }, ({ db, config, now }) => {
    const range = { start: weekRange(now, -(weeks - 1)).start, end: weekRange(now).end, label: L(`最近 ${weeks} 周`, `Last ${weeks} weeks`) };
    const stats = collectPeriodStats(db, range, { idleMinutes: config.activity.idleMinutes, topFiles: 0 });
    const todayLabel = formatDate(now);
    if (options.json) {
      printJson(
        stats.daily
          .filter((d) => d.date <= todayLabel)
          .map((d) => ({ date: d.date, activeSeconds: d.activeSeconds, commits: d.commits, sessions: d.sessions })),
      );
      return;
    }
    console.log(
      c.bold(L(`开发活跃度 · 最近 ${weeks} 周`, `Development activity · last ${weeks} weeks`)) +
        c.gray(L(`（${METRICS[metric].label()}）`, ` (${METRICS[metric].label()})`)),
    );
    console.log('');
    process.stdout.write(renderHeatmap(stats.daily, metric, todayLabel));
  });
}
