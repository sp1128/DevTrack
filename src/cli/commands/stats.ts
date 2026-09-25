import fs from 'node:fs';
import { categoryLabel } from '../../core/commands.js';
import { L } from '../../i18n.js';
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

    const n = formatNumber;
    console.log(c.bold(L('DevTrack 总体统计', 'DevTrack overall statistics')));
    console.log('');
    console.log(
      keyValues([
        [L('数据目录', 'Data directory'), `${tildify(paths.dataDir)}${c.gray(L(`（数据库 ${formatBytes(dbSize)}）`, ` (database ${formatBytes(dbSize)})`))}`],
        [L('首次记录', 'First record'), first ? formatDate(first) : c.gray(L('暂无', 'none'))],
        [L('累计开发时长', 'Total active time'), c.bold(formatDuration(stats.activeSeconds))],
        [L('活跃天数', 'Active days'), L(`${stats.activeDays} 天`, String(stats.activeDays))],
        [
          L('Claude 会话', 'Claude sessions'),
          L(`${n(stats.sessions.length)} 个（提示词 ${n(stats.prompts)} 条）`, `${n(stats.sessions.length)} (${n(stats.prompts)} prompts)`),
        ],
        [L('项目', 'Projects'), L(`${stats.projects.length} 个`, String(stats.projects.length))],
        [
          L('Git 提交', 'Git commits'),
          L(
            `${n(stats.commitTotals.count)} 次（+${n(stats.commitTotals.insertions)} / -${n(stats.commitTotals.deletions)} 行）`,
            `${n(stats.commitTotals.count)} (+${n(stats.commitTotals.insertions)} / -${n(stats.commitTotals.deletions)} lines)`,
          ),
        ],
        [
          L('修改文件', 'Files modified'),
          L(`${n(stats.files.distinct)} 个（${n(stats.files.edits)} 次修改）`, `${n(stats.files.distinct)} (${n(stats.files.edits)} edits)`),
        ],
        [
          L('执行命令', 'Commands run'),
          L(`${n(stats.commands.total)} 次（失败 ${n(stats.commands.failed)}）`, `${n(stats.commands.total)} (${n(stats.commands.failed)} failed)`),
        ],
        [L('完成任务', 'Tasks completed'), L(`${n(stats.tasks.completed.length)} 个`, n(stats.tasks.completed.length))],
        [L('工具调用', 'Tool calls'), L(`${n(stats.tools.reduce((m, t) => m + t.count, 0))} 次`, n(stats.tools.reduce((m, t) => m + t.count, 0)))],
        ...tokenRow(stats),
      ]),
    );

    if (stats.projects.length > 0) {
      const top = stats.projects.slice(0, 8);
      const max = Math.max(...top.map((p) => p.activeSeconds));
      console.log(heading(L('最活跃的项目', 'Most active projects')));
      console.log(
        table(
          L('项目|开发时长||提交|文件', 'Project|Active||Commits|Files').split('|'),
          top.map((p) => [p.name, formatDuration(p.activeSeconds, true), bar(p.activeSeconds, max, 16), String(p.commits), String(p.files)]),
          { alignRight: [1, 3, 4], maxWidths: [24] },
        ),
      );
    }
    if (stats.tools.length > 0) {
      const top = stats.tools.slice(0, 10);
      const total = stats.tools.reduce((m, t) => m + t.count, 0);
      console.log(heading(L('常用工具', 'Top tools')));
      console.log(
        table(
          L('工具|次数|占比|失败', 'Tool|Calls|Share|Failed').split('|'),
          top.map((t) => [t.tool, n(t.count), percent(t.count, total), t.failures > 0 ? c.red(String(t.failures)) : '0']),
          { alignRight: [1, 2, 3], maxWidths: [36] },
        ),
      );
    }
    if (stats.commands.byCategory.length > 0) {
      console.log(heading(L('命令类别', 'Command categories')));
      console.log(
        table(
          L('类别|次数|失败|失败率', 'Category|Runs|Failed|Failure rate').split('|'),
          stats.commands.byCategory.map((cat) => [
            categoryLabel(cat.category),
            String(cat.total),
            String(cat.failed),
            percent(cat.failed, cat.total),
          ]),
          { alignRight: [1, 2, 3] },
        ),
      );
    }
    for (const line of renderTokens(stats)) console.log(line);
    console.log(heading(L('数据表', 'Tables')));
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
