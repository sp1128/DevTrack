import fs from 'node:fs';
import path from 'node:path';
import { estimateCost } from '../../core/pricing.js';
import { formatDate, parseCutoff } from '../../core/time.js';
import type { DB } from '../../db/database.js';
import { tildify } from '../../paths.js';
import { collectPeriodStats, earliestRecord, type PeriodStats } from '../../stats/queries.js';
import type { DevTrackConfig } from '../../config.js';
import { CliError, withCli } from '../context.js';
import { c } from '../format.js';
import { L } from '../../i18n.js';

export const EXPORT_TYPES = ['sessions', 'daily', 'projects', 'commits', 'files', 'commands', 'tasks', 'tokens'] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];

export interface ExportOptions {
  format?: string;
  type?: string;
  since?: string;
  until?: string;
  output?: string;
  sync?: boolean;
}

type Row = Record<string, string | number | boolean | null>;

const round2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);
const round6 = (n: number | null) => (n === null ? null : Math.round(n * 1e6) / 1e6);

/** 按类型取出导出的行。时间均为 UTC ISO-8601，日期为本地日期。 */
export function exportRows(
  db: DB,
  stats: PeriodStats,
  type: ExportType,
  range: { start: Date; end: Date },
  config: DevTrackConfig,
): Row[] {
  const start = range.start.toISOString();
  const end = range.end.toISOString();
  switch (type) {
    case 'sessions':
      return stats.sessions.map((s) => ({
        session_id: s.sessionId,
        project: s.projectName,
        started_at: s.startedAt,
        ended_at: s.endedAt,
        status: s.status,
        active_minutes: Math.round(s.activeSeconds / 60),
        model: s.model,
        title: s.title,
        summary: s.summary,
      }));
    case 'daily':
      return stats.daily.map((d) => ({
        date: d.date,
        active_minutes: Math.round(d.activeSeconds / 60),
        sessions: d.sessions,
        commits: d.commits,
        file_edits: d.fileEdits,
        commands: d.commands,
        tokens: d.tokens,
        cost_usd: round2(d.cost),
      }));
    case 'projects':
      return stats.projects.map((p) => ({
        project: p.name,
        path: p.path,
        git_remote: p.gitRemote,
        active_minutes: Math.round(p.activeSeconds / 60),
        sessions: p.sessions,
        commits: p.commits,
        insertions: p.insertions,
        deletions: p.deletions,
        files: p.files,
        file_edits: p.fileEdits,
        commands: p.commands,
        command_failures: p.commandFailures,
        tasks_completed: p.tasksCompleted,
        tokens: p.tokens,
        cost_usd: round2(p.cost),
      }));
    case 'commits':
      return [...stats.commits].reverse().map((cm) => ({
        timestamp: cm.timestamp,
        project: cm.projectName,
        hash: cm.hash,
        branch: cm.branch,
        author: cm.author,
        message: cm.message,
        files_changed: cm.filesChanged,
        insertions: cm.insertions,
        deletions: cm.deletions,
        during_claude_session: cm.withClaude,
      }));
    case 'files':
      return db
        .prepare(
          `SELECT f.timestamp, p.name AS project, f.file_path, f.action, f.source, f.tool_name, s.session_id
             FROM file_changes f LEFT JOIN projects p ON p.id = f.project_id LEFT JOIN sessions s ON s.id = f.session_id
            WHERE f.timestamp >= ? AND f.timestamp < ? ORDER BY f.timestamp`,
        )
        .all(start, end) as Row[];
    case 'commands':
      return db
        .prepare(
          `SELECT m.timestamp, p.name AS project, m.command, m.category, m.status, m.exit_code, m.duration_ms, s.session_id
             FROM commands m LEFT JOIN projects p ON p.id = m.project_id LEFT JOIN sessions s ON s.id = m.session_id
            WHERE m.timestamp >= ? AND m.timestamp < ? ORDER BY m.timestamp`,
        )
        .all(start, end) as Row[];
    case 'tasks':
      return db
        .prepare(
          `SELECT t.created_at, t.completed_at, p.name AS project, t.title, t.status, t.source
             FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
            WHERE t.status != 'deleted' AND COALESCE(t.completed_at, t.created_at) >= ? AND COALESCE(t.completed_at, t.created_at) < ?
            ORDER BY t.created_at`,
        )
        .all(start, end) as Row[];
    case 'tokens':
      return (
        db
          .prepare(
            `SELECT u.timestamp, p.name AS project, s.session_id, u.model, u.input_tokens, u.output_tokens,
                    u.cache_read_tokens, u.cache_write_5m_tokens, u.cache_write_1h_tokens
               FROM token_usage u LEFT JOIN projects p ON p.id = u.project_id LEFT JOIN sessions s ON s.id = u.session_id
              WHERE u.timestamp >= ? AND u.timestamp < ? ORDER BY u.timestamp`,
          )
          .all(start, end) as {
          timestamp: string;
          project: string | null;
          session_id: string | null;
          model: string | null;
          input_tokens: number;
          output_tokens: number;
          cache_read_tokens: number;
          cache_write_5m_tokens: number;
          cache_write_1h_tokens: number;
        }[]
      ).map((u) => ({
        ...u,
        cost_usd: round6(
          estimateCost(
            u.model,
            {
              input: u.input_tokens,
              output: u.output_tokens,
              cacheRead: u.cache_read_tokens,
              cacheWrite5m: u.cache_write_5m_tokens,
              cacheWrite1h: u.cache_write_1h_tokens,
            },
            config.usage.prices,
          ),
        ),
      }));
  }
}

/** CSV 单元格：按 RFC 4180 转义；以 = + - @ 开头的文本加 ' 前缀，防止在 Excel 中被当作公式执行。 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text) && !/^[+-]?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: Row[], columns?: string[]): string {
  const headers = columns ?? (rows[0] ? Object.keys(rows[0]) : []);
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvCell(row[h])).join(','));
  return lines.join('\r\n') + '\r\n';
}

/** 空结果时 CSV 仍输出表头 */
const EMPTY_COLUMNS: Record<ExportType, string[]> = {
  sessions: ['session_id', 'project', 'started_at', 'ended_at', 'status', 'active_minutes', 'model', 'title', 'summary'],
  daily: ['date', 'active_minutes', 'sessions', 'commits', 'file_edits', 'commands', 'tokens', 'cost_usd'],
  projects: ['project', 'path', 'git_remote', 'active_minutes', 'sessions', 'commits'],
  commits: ['timestamp', 'project', 'hash', 'branch', 'author', 'message', 'files_changed', 'insertions', 'deletions'],
  files: ['timestamp', 'project', 'file_path', 'action', 'source', 'tool_name', 'session_id'],
  commands: ['timestamp', 'project', 'command', 'category', 'status', 'exit_code', 'duration_ms', 'session_id'],
  tasks: ['created_at', 'completed_at', 'project', 'title', 'status', 'source'],
  tokens: ['timestamp', 'project', 'session_id', 'model', 'input_tokens', 'output_tokens', 'cost_usd'],
};

export async function runExport(options: ExportOptions): Promise<void> {
  const format = (options.format ?? 'csv').toLowerCase();
  if (format !== 'csv' && format !== 'json') throw new CliError(`--format 只支持 csv / json：${options.format}`);
  const type = options.type as ExportType | undefined;
  if (type !== undefined && !EXPORT_TYPES.includes(type)) {
    throw new CliError(`--type 只支持 ${EXPORT_TYPES.join(' / ')}：${options.type}`);
  }

  await withCli({ sync: options.sync }, ({ db, config, now }) => {
    let start: Date;
    if (options.since) {
      const parsed = parseCutoff(options.since, now);
      if (!parsed) throw new CliError(`无法识别的时间：${options.since}（示例：30d、12w、2026-01-01）`);
      start = parsed;
    } else {
      start = earliestRecord(db) ?? now;
    }
    let end = now;
    if (options.until) {
      const parsed = parseCutoff(options.until, now);
      if (!parsed) throw new CliError(`无法识别的时间：${options.until}（示例：2026-10-01）`);
      end = parsed;
    }
    if (end <= start) end = new Date(start.getTime() + 1);
    const range = { start, end, label: `${formatDate(start)} ~ ${formatDate(end)}` };
    const stats = collectPeriodStats(db, range, { idleMinutes: config.activity.idleMinutes, prices: config.usage.prices });

    let output: string;
    if (format === 'json') {
      const types = type ? [type] : EXPORT_TYPES;
      const data: Record<string, unknown> = { range: { start: start.toISOString(), end: end.toISOString() } };
      for (const t of types) data[t] = exportRows(db, stats, t, range, config);
      output = JSON.stringify(data, null, 2) + '\n';
    } else {
      const t = type ?? 'sessions';
      const rows = exportRows(db, stats, t, range, config);
      output = toCsv(rows, rows.length === 0 ? EMPTY_COLUMNS[t] : undefined);
    }

    if (!options.output) {
      process.stdout.write(output);
      return;
    }
    const target = path.resolve(options.output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // 写入文件时 CSV 加 UTF-8 BOM，Excel 才能正确识别中文
    fs.writeFileSync(target, format === 'csv' ? '﻿' + output : output, 'utf8');
    console.error(`${c.green('✔')} ${L('已导出到', 'Exported to')} ${tildify(target)}`);
  });
}
