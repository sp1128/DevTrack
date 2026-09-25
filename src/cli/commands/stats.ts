import fs from 'node:fs';
import { CATEGORY_LABELS, type CommandCategory } from '../../core/commands.js';
import { formatBytes, formatDuration, formatNumber, percent } from '../../core/format.js';
import { formatDate, startOfDayLocal } from '../../core/time.js';
import { tableCounts } from '../../db/database.js';
import { tildify } from '../../paths.js';
import { collectPeriodStats, earliestRecord } from '../../stats/queries.js';
import { printJson, withCli } from '../context.js';
import { renderTokens, tokenRow } from '../render.js';
import { bar, c, heading, keyValues, table } from '../format.js';

export async function runStats(options: { json?: boolean; sync?: boolean }): Promise<void> {
  await withCli({ sync: options.sync }, ({ db, config, paths, now }) => {
    const first = earliestRecord(db);
    const range = {
      start: startOfDayLocal(first ?? now),
      end: new Date(now.getTime() + 60_000),
      label: '全部记录',
    };
    const stats = collectPeriodStats(db, range, {
      idleMinutes: config.activity.idleMinutes,
      prices: config.usage.prices,
      topFiles: 10,
    });
    const counts = tableCounts(db);
    const dbSize = ['', '-wal'].reduce((n, suffix) => {
      try {
        return n + fs.statSync(paths.dbFile + suffix).size;
      } catch {
        return n;
      }
    }, 0);

    if (options.json) {
      printJson({ firstRecord: first?.toISOString() ?? null, databaseBytes: dbSize, tableCounts: counts, stats });
      return;
    }

    console.log(c.bold('DevTrack 总体统计'));
    console.log('');
    console.log(
      keyValues([
        ['数据目录', `${tildify(paths.dataDir)}${c.gray(`（数据库 ${formatBytes(dbSize)}）`)}`],
        ['首次记录', first ? formatDate(first) : c.gray('暂无')],
        ['累计开发时长', c.bold(formatDuration(stats.activeSeconds))],
        ['活跃天数', `${stats.activeDays} 天`],
        ['Claude 会话', `${formatNumber(stats.sessions.length)} 个（提示词 ${formatNumber(stats.prompts)} 条）`],
        ['项目', `${stats.projects.length} 个`],
        [
          'Git 提交',
          `${formatNumber(stats.commitTotals.count)} 次（+${formatNumber(stats.commitTotals.insertions)} / -${formatNumber(stats.commitTotals.deletions)} 行）`,
        ],
        ['修改文件', `${formatNumber(stats.files.distinct)} 个（${formatNumber(stats.files.edits)} 次修改）`],
        ['执行命令', `${formatNumber(stats.commands.total)} 次（失败 ${formatNumber(stats.commands.failed)}）`],
        ['完成任务', `${formatNumber(stats.tasks.completed.length)} 个`],
        ['工具调用', `${formatNumber(stats.tools.reduce((n, t) => n + t.count, 0))} 次`],
        ...tokenRow(stats),
      ]),
    );

    if (stats.projects.length > 0) {
      const top = stats.projects.slice(0, 8);
      const max = Math.max(...top.map((p) => p.activeSeconds));
      console.log(heading('最活跃的项目'));
      console.log(
        table(
          ['项目', '开发时长', '', '提交', '文件'],
          top.map((p) => [p.name, formatDuration(p.activeSeconds, true), bar(p.activeSeconds, max, 16), String(p.commits), String(p.files)]),
          { alignRight: [1, 3, 4], maxWidths: [24] },
        ),
      );
    }
    if (stats.tools.length > 0) {
      const top = stats.tools.slice(0, 10);
      const total = stats.tools.reduce((n, t) => n + t.count, 0);
      console.log(heading('常用工具'));
      console.log(
        table(
          ['工具', '次数', '占比', '失败'],
          top.map((t) => [t.tool, formatNumber(t.count), percent(t.count, total), t.failures > 0 ? c.red(String(t.failures)) : '0']),
          { alignRight: [1, 2, 3], maxWidths: [36] },
        ),
      );
    }
    if (stats.commands.byCategory.length > 0) {
      console.log(heading('命令类别'));
      console.log(
        table(
          ['类别', '次数', '失败', '失败率'],
          stats.commands.byCategory.map((cat) => [
            CATEGORY_LABELS[cat.category as CommandCategory] ?? cat.category,
            String(cat.total),
            String(cat.failed),
            percent(cat.failed, cat.total),
          ]),
          { alignRight: [1, 2, 3] },
        ),
      );
    }
    for (const line of renderTokens(stats)) console.log(line);
    console.log(heading('数据表'));
    console.log(
      c.gray(
        `  ${Object.entries(counts)
          .map(([k, v]) => `${k} ${formatNumber(v)}`)
          .join(' · ')}`,
      ),
    );
    console.log('');
  });
}
