import os from 'node:os';
import type { DevTrackConfig } from '../config.js';
import { classifyCommand, isIgnoredCommand, parseExitCode, sanitizeCommand } from '../core/commands.js';
import { diffWorkingTree, snapshotBaseline, syncProjectCommits } from '../core/gitSync.js';
import { detectProject, isProjectExcluded, relativizePath } from '../core/project.js';
import { sanitizeText, summarizePrompt } from '../core/text.js';
import { ingestTranscript } from '../core/transcript.js';
import type { DB } from '../db/database.js';
import { autoPurge } from '../db/purge.js';
import {
  closeStaleSessions,
  createSession,
  endSession,
  getProject,
  getSessionByExternalId,
  insertCommand,
  insertEvent,
  insertFileChange,
  touchProject,
  touchSession,
  updateSessionMeta,
  upsertProject,
  upsertTask,
  type FileAction,
  type ProjectRow,
  type SessionRow,
  type TaskStatus,
} from '../db/repo.js';
import { logError } from '../logger.js';
import { getClaudeConfigDir, normalizePath } from '../paths.js';
import type { HookInput } from './schema.js';

export interface HookContext {
  db: DB;
  config: DevTrackConfig;
  now: Date;
}

export type HandleResult =
  | { status: 'recorded'; sessionId: number; projectId: number }
  | { status: 'skipped'; reason: string };

/** 文件编辑类工具及其路径参数名。 */
const FILE_TOOLS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const TASK_STATUSES = new Set<TaskStatus>(['pending', 'in_progress', 'completed', 'deleted']);

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}

function toSnakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * 处理一条 Claude Code Hook 事件，写入本地数据库。
 * 调用方（runner）负责捕获所有异常，确保 Hook 永远以 0 退出。
 */
export function handleHookEvent(ctx: HookContext, input: HookInput): HandleResult {
  const { db, config, now } = ctx;
  if (!config.enabled) return { status: 'skipped', reason: 'disabled' };
  const ts = now.toISOString();
  const event = input.hook_event_name;

  let session = getSessionByExternalId(db, input.session_id);
  let project: ProjectRow | undefined;
  let isNewSession = false;

  if (session) {
    project = session.project_id !== null ? getProject(db, session.project_id) : undefined;
    if (!project) return { status: 'skipped', reason: 'project-missing' };
    if (isProjectExcluded(project, config.privacy.excludeProjects)) return { status: 'skipped', reason: 'excluded' };
  } else {
    // 没见过开始事件就收到结束事件（例如会话中途安装了 DevTrack），不创建空会话
    if (event === 'SessionEnd') return { status: 'skipped', reason: 'unknown-session' };
    const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR;
    if (!cwd) return { status: 'skipped', reason: 'no-cwd' };
    const detected = detectProject(cwd);
    if (isProjectExcluded(detected, config.privacy.excludeProjects)) return { status: 'skipped', reason: 'excluded' };
    project = upsertProject(
      db,
      { name: detected.name, path: detected.path, gitRemote: detected.gitRemote, isGit: detected.isGit },
      ts,
    );
    session = createSession(db, {
      projectId: project.id,
      sessionId: input.session_id,
      cwd: normalizePath(cwd),
      workRoot: detected.workRoot,
      gitBranch: detected.gitBranch,
      source: event === 'SessionStart' ? (input.source ?? null) : null,
      model: input.model ?? null,
      title: input.session_title ? sanitizeText(input.session_title, 120, config.privacy.redactPatterns) : null,
      ts,
    });
    isNewSession = true;
  }

  const base = { sessionId: session.id, projectId: project.id };
  let git: { commits: boolean; throttle?: number; baseline: boolean; diff: boolean } = {
    commits: isNewSession,
    baseline: isNewSession,
    diff: false,
  };

  switch (event) {
    case 'SessionStart': {
      touchSession(db, session, ts);
      updateSessionMeta(db, session.id, {
        source: input.source ?? null,
        model: input.model ?? null,
        title: input.session_title ? sanitizeText(input.session_title, 120, config.privacy.redactPatterns) : null,
      });
      insertEvent(db, {
        ...base,
        type: 'session_start',
        ts,
        metadata: { source: input.source, model: input.model },
      });
      closeStaleSessions(db, now);
      try {
        autoPurge(db, config.retention.days, now);
      } catch (err) {
        logError('auto-purge', err);
      }
      // 上下文压缩发生在会话中途：对比工作区而不是重置基线，避免丢失压缩前产生的文件变化
      const compacting = input.source === 'compact' && !isNewSession;
      git = { commits: true, baseline: !compacting, diff: compacting };
      break;
    }
    case 'SessionEnd': {
      insertEvent(db, { ...base, type: 'session_end', ts, metadata: { reason: input.reason } });
      endSession(db, session, ts, input.reason ?? null);
      git = { commits: true, baseline: false, diff: true };
      break;
    }
    case 'UserPromptSubmit': {
      touchSession(db, session, ts);
      // 只记录提示词长度，不保存内容
      insertEvent(db, { ...base, type: 'prompt', ts, metadata: { length: input.prompt?.length ?? 0 } });
      if (config.collect.promptSummary && !session.title && input.prompt) {
        const title = summarizePrompt(input.prompt, config.privacy.redactPatterns);
        if (title) updateSessionMeta(db, session.id, { title });
      }
      break;
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      touchSession(db, session, ts);
      handleToolEvent(ctx, input, session, project, ts);
      break;
    }
    case 'Stop': {
      touchSession(db, session, ts);
      insertEvent(db, { ...base, type: 'stop', ts });
      git = { commits: true, throttle: 20, baseline: false, diff: true };
      break;
    }
    case 'TaskCreated':
    case 'TaskCompleted': {
      touchSession(db, session, ts);
      insertEvent(db, { ...base, type: toSnakeCase(event), ts });
      if (config.collect.tasks && input.task_id) {
        upsertTask(db, {
          sessionId: session.id,
          projectId: project.id,
          externalId: input.task_id,
          source: 'task',
          title: input.task_subject ? sanitizeText(input.task_subject, 200, config.privacy.redactPatterns) : null,
          description: input.task_description
            ? sanitizeText(input.task_description, 300, config.privacy.redactPatterns)
            : null,
          status: event === 'TaskCompleted' ? 'completed' : null,
          ts,
        });
      }
      break;
    }
    default: {
      touchSession(db, session, ts);
      insertEvent(db, { ...base, type: toSnakeCase(event), ts });
    }
  }

  if (event === 'SessionStart' || event === 'Stop' || event === 'SessionEnd') touchProject(db, project.id, ts);
  if ((event === 'Stop' || event === 'SessionEnd') && config.collect.tokenUsage && input.transcript_path?.endsWith('.jsonl')) {
    try {
      ingestTranscript(db, input.transcript_path, base, now);
    } catch (err) {
      logError('token-usage', err);
    }
  }
  runGitWork(ctx, session, project, ts, git);
  return { status: 'recorded', ...base };
}

function runGitWork(
  ctx: HookContext,
  session: SessionRow,
  project: ProjectRow,
  ts: string,
  work: { commits: boolean; throttle?: number; baseline: boolean; diff: boolean },
): void {
  const { db, config, now } = ctx;
  if (!project.is_git) return;
  // Git 相关失败只记日志，不影响已写入的事件
  try {
    if (config.collect.fileChanges && config.git.trackWorkingTree) {
      if (work.baseline) snapshotBaseline(db, session, project, ts);
      else if (work.diff) diffWorkingTree(db, session, project, ts);
    }
  } catch (err) {
    logError('git-status', err);
  }
  try {
    if (work.commits) syncProjectCommits(db, project, config, now, { minIntervalSeconds: work.throttle });
  } catch (err) {
    logError('git-log', err);
  }
}

function handleToolEvent(ctx: HookContext, input: HookInput, session: SessionRow, project: ProjectRow, ts: string): void {
  const { db, config } = ctx;
  const tool = input.tool_name ?? 'unknown';
  const failed = input.hook_event_name === 'PostToolUseFailure';
  const toolInput = input.tool_input ?? {};
  const response = asObject(input.tool_response);
  const base = { sessionId: session.id, projectId: project.id };

  // 工具事件只保存工具名、耗时等元数据，不保存工具输入输出
  const metadata: Json = {};
  if (typeof input.duration_ms === 'number') metadata.duration_ms = Math.round(input.duration_ms);
  if (input.agent_type) metadata.agent = input.agent_type;
  if (failed && input.is_interrupt) metadata.interrupted = true;
  insertEvent(db, { ...base, type: failed ? 'tool_failure' : 'tool_use', toolName: tool, ts, metadata });

  if (SHELL_TOOLS.has(tool) && config.collect.commands) {
    recordCommand(ctx, input, toolInput, response, failed, base, ts);
  }
  if (!failed && config.collect.fileChanges) {
    const pathKey = FILE_TOOLS[tool];
    if (pathKey) recordFileTool(ctx, input, tool, toolInput[pathKey], response, session, project, ts);
    if (SHELL_TOOLS.has(tool)) recordBashEditDiff(ctx, input, response, session, project, ts);
  }
  if (!failed && config.collect.tasks) {
    if (tool === 'TodoWrite') syncTodos(ctx, toolInput, session, project, ts);
    else if (tool === 'TaskCreate' || tool === 'TaskUpdate') recordTaskTool(ctx, tool, toolInput, response, session, project, ts);
  }
}

function recordCommand(
  ctx: HookContext,
  input: HookInput,
  toolInput: Json,
  response: Json | undefined,
  failed: boolean,
  base: { sessionId: number; projectId: number },
  ts: string,
): void {
  const { db, config } = ctx;
  const raw = toolInput.command;
  if (typeof raw !== 'string' || !raw.trim()) return;
  const command = sanitizeCommand(raw, {
    maxLength: config.commands.maxLength,
    extraRedactPatterns: config.privacy.redactPatterns,
  });
  if (isIgnoredCommand(command, config.commands.ignore)) return;

  let status: 'success' | 'failure' | 'interrupted' | 'background';
  let exitCode: number | null;
  if (failed) {
    exitCode = parseExitCode(input.error);
    status = input.is_interrupt ? 'interrupted' : 'failure';
  } else if (toolInput.run_in_background === true || typeof response?.backgroundTaskId === 'string') {
    status = 'background';
    exitCode = null;
  } else if (response?.interrupted === true) {
    status = 'interrupted';
    exitCode = null;
  } else {
    // 官方文档：命令以非 0 退出码结束时触发的是 PostToolUseFailure，因此 PostToolUse 即退出码 0
    status = 'success';
    exitCode = 0;
  }
  insertCommand(db, {
    ...base,
    command,
    category: classifyCommand(command),
    exitCode,
    durationMs: typeof input.duration_ms === 'number' ? Math.round(input.duration_ms) : null,
    status,
    ts,
  });
}

/** 临时目录、Claude 草稿目录、Claude 配置目录中的文件不计入开发文件修改。 */
function isNoisePath(absPath: string, scratchpadDir: string | undefined): boolean {
  const p = normalizePath(absPath);
  const dirs = [scratchpadDir, os.tmpdir(), getClaudeConfigDir()].filter((d): d is string => !!d).map(normalizePath);
  return dirs.some((d) => p === d || p.startsWith(d.endsWith('/') ? d : d + '/'));
}

function toStoredPath(filePath: string, session: SessionRow, project: ProjectRow, scratchpadDir?: string): string | null {
  const rel = relativizePath(filePath, [session.work_root ?? '', project.path]);
  if (!rel.inside && isNoisePath(filePath, scratchpadDir)) return null;
  return rel.path;
}

function recordFileTool(
  ctx: HookContext,
  input: HookInput,
  tool: string,
  filePath: unknown,
  response: Json | undefined,
  session: SessionRow,
  project: ProjectRow,
  ts: string,
): void {
  if (typeof filePath !== 'string' || !filePath) return;
  const stored = toStoredPath(filePath, session, project, input.scratchpad_dir);
  if (!stored) return;
  let action: FileAction = 'modify';
  // Write 的 tool_response.type 为 "create" 或 "update"
  if (tool === 'Write' && response?.type === 'create') action = 'create';
  insertFileChange(ctx.db, {
    sessionId: session.id,
    projectId: project.id,
    filePath: stored,
    action,
    source: 'claude',
    toolName: tool,
    ts,
  });
}

/**
 * Bash 命令修改的文件：Claude Code v2.1.269+ 在部分模式下会在 tool_response.bashEditDiff 中给出。
 * 没有该字段时由 Stop 事件的 git status 快照对比补充。
 */
function recordBashEditDiff(
  ctx: HookContext,
  input: HookInput,
  response: Json | undefined,
  session: SessionRow,
  project: ProjectRow,
  ts: string,
): void {
  const diff = asObject(response?.bashEditDiff);
  if (!diff || diff.skipped === true) return;
  const flags = new Map<string, FileAction>();
  if (Array.isArray(diff.files)) {
    for (const f of diff.files) {
      const file = asObject(f);
      if (file && typeof file.filePath === 'string') {
        flags.set(file.filePath, file.created === true ? 'create' : file.deleted === true ? 'delete' : 'modify');
      }
    }
  }
  const changed: string[] = Array.isArray(diff.changedFiles)
    ? diff.changedFiles.filter((f): f is string => typeof f === 'string')
    : [...flags.keys()];
  for (const filePath of changed.slice(0, 200)) {
    const stored = toStoredPath(filePath, session, project, input.scratchpad_dir);
    if (!stored) continue;
    insertFileChange(ctx.db, {
      sessionId: session.id,
      projectId: project.id,
      filePath: stored,
      action: flags.get(filePath) ?? 'modify',
      source: 'bash',
      toolName: input.tool_name ?? 'Bash',
      ts,
    });
  }
}

/** TodoWrite（旧版任务清单工具，CLAUDE_CODE_ENABLE_TASKS=0 时启用）：每次调用给出完整清单。 */
function syncTodos(ctx: HookContext, toolInput: Json, session: SessionRow, project: ProjectRow, ts: string): void {
  const todos = toolInput.todos;
  if (!Array.isArray(todos)) return;
  const extra = ctx.config.privacy.redactPatterns;
  ctx.db.transaction(() => {
    for (const item of todos) {
      const todo = asObject(item);
      if (!todo || typeof todo.content !== 'string' || !todo.content.trim()) continue;
      const status = TASK_STATUSES.has(todo.status as TaskStatus) ? (todo.status as TaskStatus) : null;
      upsertTask(ctx.db, {
        sessionId: session.id,
        projectId: project.id,
        externalId: todo.content.trim().toLowerCase().slice(0, 200),
        source: 'todo',
        title: sanitizeText(todo.content, 200, extra),
        status,
        ts,
      });
    }
  })();
}

/** TaskCreate / TaskUpdate 工具（新版任务工具）。创建与完成也会通过 TaskCreated / TaskCompleted 事件到达。 */
function recordTaskTool(
  ctx: HookContext,
  tool: string,
  toolInput: Json,
  response: Json | undefined,
  session: SessionRow,
  project: ProjectRow,
  ts: string,
): void {
  const extra = ctx.config.privacy.redactPatterns;
  const subject = typeof toolInput.subject === 'string' ? sanitizeText(toolInput.subject, 200, extra) : null;
  const description =
    typeof toolInput.description === 'string' ? sanitizeText(toolInput.description, 300, extra) : null;
  let taskId: unknown;
  let status: TaskStatus | null = null;
  if (tool === 'TaskUpdate') {
    taskId = toolInput.taskId;
    if (TASK_STATUSES.has(toolInput.status as TaskStatus)) status = toolInput.status as TaskStatus;
  } else {
    const task = asObject(response?.task);
    taskId = task?.id ?? response?.id ?? response?.taskId;
  }
  if (typeof taskId !== 'string' && typeof taskId !== 'number') return;
  upsertTask(ctx.db, {
    sessionId: session.id,
    projectId: project.id,
    externalId: String(taskId),
    source: 'task',
    title: subject,
    description,
    status,
    ts,
  });
}
