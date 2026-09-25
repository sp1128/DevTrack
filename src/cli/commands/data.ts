import fs from 'node:fs';
import { formatDateTime, parseCutoff } from '../../core/time.js';
import { openDatabase } from '../../db/database.js';
import { countPurge, purgeBefore } from '../../db/purge.js';
import { inspectHooks, SettingsError, uninstallHooks } from '../../hooks/install.js';
import { getClaudeSettingsPath, getPaths, tildify } from '../../paths.js';
import { CliError, confirm, loadConfigOrThrow } from '../context.js';
import { c, table } from '../format.js';

export async function runPurge(options: { before: string; yes?: boolean; dryRun?: boolean }): Promise<void> {
  loadConfigOrThrow();
  const now = new Date();
  const cutoff = parseCutoff(options.before, now);
  if (!cutoff) throw new CliError(`无法解析 --before ${options.before}（示例：30d、12w、6m、1y、2026-01-01）`);
  const paths = getPaths();
  if (!fs.existsSync(paths.dbFile)) {
    console.log('数据库不存在，没有需要清理的数据。');
    return;
  }
  const db = openDatabase(paths.dbFile);
  try {
    const counts = countPurge(db, cutoff, now);
    const total = counts.reduce((n, r) => n + r.count, 0);
    console.log(`将删除 ${c.bold(formatDateTime(cutoff))} 之前的数据：`);
    console.log(table(['类型', '条数'], counts.map((r) => [r.label, String(r.count)]), { alignRight: [1] }));
    if (total === 0) {
      console.log(c.gray('\n没有需要删除的数据。'));
      return;
    }
    if (options.dryRun) {
      console.log(c.gray('\n--dry-run：未删除任何数据。'));
      return;
    }
    if (!(await confirm(`\n确认删除以上 ${total} 条记录？此操作不可恢复。`, options.yes))) {
      console.log('已取消。');
      return;
    }
    purgeBefore(db, cutoff, now);
    // 回收空间并确保已删除的数据不再残留在数据库文件中
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    console.log(`${c.green('✔')} 已删除 ${total} 条记录。`);
    console.log(c.gray(`  已生成的周报文件不受影响，如需删除请手动清理 ${tildify(paths.reportsDir)}`));
  } finally {
    db.close();
  }
}

function removeFile(file: string): void {
  try {
    fs.rmSync(file, { force: true, recursive: true });
  } catch (err) {
    throw new CliError(`无法删除 ${file}：${(err as Error).message}（请先退出正在运行的 Claude Code 后重试）`);
  }
}

export async function runReset(options: { yes?: boolean; all?: boolean }): Promise<void> {
  const paths = getPaths();
  const targets = options.all
    ? [paths.dataDir]
    : [paths.dbFile, `${paths.dbFile}-wal`, `${paths.dbFile}-shm`, paths.logsDir, paths.reportsDir];
  console.log(options.all ? '将删除整个 DevTrack 数据目录（包括配置）：' : '将删除所有已采集的数据（保留配置文件）：');
  for (const t of targets) console.log(`  - ${tildify(t)}`);
  if (!(await confirm('确认执行？此操作不可恢复。', options.yes))) {
    console.log('已取消。');
    return;
  }
  for (const t of targets) removeFile(t);
  if (!options.all) {
    const db = openDatabase(paths.dbFile);
    db.close();
  }
  console.log(`${c.green('✔')} 数据已清空。`);
  if (inspectHooks(getClaudeSettingsPath()).installed.length > 0) {
    console.log(c.gray('  Claude Code Hook 仍然保留，之后的开发活动会继续记录；如需停止记录，运行 devtrack uninstall。'));
  }
}

export async function runUninstall(options: { settings?: string; purge?: boolean; yes?: boolean }): Promise<void> {
  const paths = getPaths();
  const settingsPath = options.settings ?? getClaudeSettingsPath();
  try {
    const result = uninstallHooks({ settingsPath, backupDir: paths.backupsDir });
    if (result.removed > 0) {
      console.log(`${c.green('✔')} 已从 ${tildify(settingsPath)} 移除 ${result.removed} 个 DevTrack Hook。`);
      if (result.backupPath) console.log(c.gray(`  原文件已备份到 ${tildify(result.backupPath)}`));
    } else {
      console.log(`${tildify(settingsPath)} 中没有 DevTrack Hook。`);
    }
  } catch (err) {
    if (err instanceof SettingsError) throw new CliError(err.message);
    throw err;
  }
  if (options.purge) {
    await runReset({ yes: options.yes, all: true });
  } else {
    console.log(c.gray(`  已采集的数据仍保存在 ${tildify(paths.dataDir)}；如需一并删除，运行 devtrack reset --all。`));
  }
  console.log(c.gray('  如果全局安装了 devtrack，可运行 npm uninstall -g devtrack 卸载命令本身。'));
}
