/** DevTrack 的编程接口（CLI 之外的用法，例如在脚本中读取统计数据）。 */
export { ConfigSchema, defaultConfig, loadConfig, saveConfig, type DevTrackConfig } from './config.js';
export { getDataDir, getPaths, getClaudeSettingsPath, type DevTrackPaths } from './paths.js';
export { openDatabase, migrate, type DB } from './db/database.js';
export { handleHookEvent, type HookContext, type HandleResult } from './hooks/handler.js';
export { HookInputSchema, HOOK_EVENTS, type HookInput } from './hooks/schema.js';
export { installHooks, uninstallHooks, inspectHooks } from './hooks/install.js';
export { redact } from './core/redact.js';
export { sanitizeCommand, classifyCommand } from './core/commands.js';
export { detectProject } from './core/project.js';
export { collectPeriodStats, type PeriodStats } from './stats/queries.js';
export { buildWeeklyReport } from './report/weekly.js';
export { generateAiSummary, buildAiPayload } from './report/ai.js';
export { todayRange, weekRange, monthRange, isoWeekLabel, parseIsoWeek } from './core/time.js';
