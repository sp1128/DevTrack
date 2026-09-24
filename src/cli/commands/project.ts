import path from 'node:path';
import { formatDuration } from '../../core/format.js';
import { detectProject } from '../../core/project.js';
import { formatDateTime, parseCutoff, startOfDayLocal, type DateRange } from '../../core/time.js';
import { listProjects, type ProjectRow } from '../../db/repo.js';
import { normalizePath, tildify } from '../../paths.js';
import { collectPeriodStats, earliestRecord } from '../../stats/queries.js';
import { CliError, printJson, withCli } from '../context.js';
import { c, heading, keyValues, table } from '../format.js';
import { renderPeriodSummary } from '../render.js';

export interface ProjectOptions {
  json?: boolean;
  sync?: boolean;
  since?: string;
}

function resolveRange(db: Parameters<typeof earliestRecord>[0], now: Date, since?: string): DateRange {
  const end = new Date(now.getTime() + 60_000);
  if (since) {
    const cutoff = parseCutoff(since, now);
    if (!cutoff) throw new CliError(`无法解析时间范围：${since}（示例：7d、4w、3m、2026-09-01）`);
    return { start: cutoff, end, label: `自 ${formatDateTime(cutoff)} 起` };
  }
  const first = earliestRecord(db) ?? now;
  return { start: startOfDayLocal(first), end, label: '全部记录' };
}

function findProject(projects: ProjectRow[], query: string): ProjectRow {
  const looksLikePath = query === '.' || query.includes('/') || query.includes('\\') || query.startsWith('~');
  if (looksLikePath) {
    const resolved = query === '.' ? detectProject(process.cwd()).path : normalizePath(path.resolve(query));
    const cmp = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const hit = projects.find((p) => cmp(p.path) === cmp(resolved));
    if (!hit) throw new CliError(`没有找到路径为 ${resolved} 的项目记录。运行 devtrack project 查看所有项目。`);
    return hit;
  }
  const matches = projects.filter((p) => p.name.toLowerCase() === query.toLowerCase());
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new CliError(
      `有多个名为 ${query} 的项目，请改用路径指定：\n${matches.map((m) => `  devtrack project ${m.path}`).join('\n')}`,
    );
  }
  const fuzzy = projects.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));
  if (fuzzy.length === 1) return fuzzy[0]!;
  throw new CliError(
    fuzzy.length > 1
      ? `匹配到多个项目：${fuzzy.map((p) => p.name).join('、')}，请输入完整名称。`
      : `没有找到项目：${query}。运行 devtrack project 查看所有项目。`,
  );
}

export async function runProject(query: string | undefined, options: ProjectOptions): Promise<void> {
  await withCli({ sync: options.sync }, ({ db, config, now }) => {
    const projects = listProjects(db);
    const range = resolveRange(db, now, options.since);

    if (!query) {
      const stats = collectPeriodStats(db, range, { idleMinutes: config.activity.idleMinutes });
      const byId = new Map(stats.projects.map((p) => [p.id, p]));
      const rows = projects.map((p) => ({ project: p, summary: byId.get(p.id) }));
      if (options.json) {
        printJson(rows.map(({ project, summary }) => ({ ...project, stats: summary ?? null })));
        return;
      }
      console.log(c.bold(`项目（${projects.length}）`) + c.gray(` · ${range.label}`));
      if (projects.length === 0) {
        console.log(c.gray('\n  还没有记录到任何项目。在任意目录中使用 Claude Code 后，项目会被自动识别。\n'));
        return;
      }
      console.log('');
      console.log(
        table(
          ['项目', '开发时长', '会话', '提交', '文件', '最近活动', '路径'],
          rows
            .sort((a, b) => (b.summary?.activeSeconds ?? 0) - (a.summary?.activeSeconds ?? 0) || b.project.updated_at.localeCompare(a.project.updated_at))
            .map(({ project, summary }) => [
              project.name,
              formatDuration(summary?.activeSeconds ?? 0, true),
              String(summary?.sessions ?? 0),
              String(summary?.commits ?? 0),
              String(summary?.files ?? 0),
              formatDateTime(new Date(project.updated_at)).slice(5),
              c.gray(tildify(project.path)),
            ]),
          { alignRight: [1, 2, 3, 4], maxWidths: [24] },
        ),
      );
      console.log(c.gray(`\n  查看详情：devtrack project <项目名>`));
      return;
    }

    const project = findProject(projects, query);
    const stats = collectPeriodStats(db, range, {
      idleMinutes: config.activity.idleMinutes,
      projectId: project.id,
      topFiles: 15,
    });
    if (options.json) {
      printJson({ project, stats });
      return;
    }
    console.log(c.bold(`项目 · ${project.name}`));
    console.log('');
    console.log(
      keyValues([
        ['路径', tildify(project.path)],
        ['远程仓库', project.git_remote ?? c.gray('-')],
        ['Git 仓库', project.is_git ? '是' : '否'],
        ['首次记录', formatDateTime(new Date(project.created_at))],
        ['最近活动', formatDateTime(new Date(project.updated_at))],
      ]),
    );
    console.log(heading('统计'));
    process.stdout.write(renderPeriodSummary(stats, project.name, true, { singleProject: true }));
  });
}
