import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  defaultConfig,
  getConfigValue,
  loadConfig,
  loadConfigSafe,
  parseConfigValue,
  saveConfig,
  setConfigValue,
} from '../src/config.js';
import {
  isoWeekLabel,
  monthRange,
  parseCutoff,
  parseIsoWeek,
  parseMonth,
  todayRange,
  weekRange,
} from '../src/core/time.js';
import { makeTempDir, rmrf } from './helpers.js';

describe('config', () => {
  let dir: string | undefined;
  afterEach(() => dir && rmrf(dir));

  it('默认配置：全部采集开启，提示词摘要默认关闭', () => {
    const c = defaultConfig();
    expect(c.enabled).toBe(true);
    expect(c.collect).toEqual({ commands: true, fileChanges: true, git: true, tasks: true, promptSummary: false, tokenUsage: false });
    expect(c.activity.idleMinutes).toBe(30);
    expect(c.ai.provider).toBe('anthropic');
  });

  it('保存与读取；缺省字段自动补全', () => {
    dir = makeTempDir();
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ collect: { commands: false } }));
    const c = loadConfig(file);
    expect(c.collect.commands).toBe(false);
    expect(c.collect.git).toBe(true);
    saveConfig(c, file);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).collect.commands).toBe(false);
  });

  it('非法配置抛出 ConfigError；Hook 场景退回默认值', () => {
    dir = makeTempDir();
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{ not json');
    expect(() => loadConfig(file)).toThrow(ConfigError);
    fs.writeFileSync(file, JSON.stringify({ activity: { idleMinutes: -1 } }));
    expect(() => loadConfig(file)).toThrow(/idleMinutes/);
    const safe = loadConfigSafe(file);
    expect(safe.error).toBeInstanceOf(ConfigError);
    expect(safe.config.activity.idleMinutes).toBe(30);
  });

  it('按点号路径读写配置项', () => {
    let c = defaultConfig();
    c = setConfigValue(c, 'collect.commands', parseConfigValue('false'));
    expect(getConfigValue(c, 'collect.commands')).toBe(false);
    c = setConfigValue(c, 'ai.model', parseConfigValue('deepseek-chat'));
    expect(c.ai.model).toBe('deepseek-chat');
    c = setConfigValue(c, 'ai.model', null);
    expect(c.ai.model).toBeUndefined();
    c = setConfigValue(c, 'privacy.excludeProjects', parseConfigValue('["secret-repo"]'));
    expect(c.privacy.excludeProjects).toEqual(['secret-repo']);
    expect(() => setConfigValue(c, 'collect.unknown', true)).toThrow(/未知的配置项/);
    expect(() => setConfigValue(c, 'activity.idleMinutes', 'abc')).toThrow(/配置值无效/);
    expect(() => getConfigValue(c, 'nope.x')).toThrow(ConfigError);
  });
});

describe('time', () => {
  // vitest.config.ts 中 TZ=UTC
  const now = new Date('2026-09-24T10:00:00Z'); // 周四

  it('ISO 周编号与文档示例一致：2026-09-24 属于 2026-W39', () => {
    expect(isoWeekLabel(now)).toBe('2026-W39');
    const w = weekRange(now);
    expect(w.start.toISOString()).toBe('2026-09-21T00:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect(weekRange(now, -1).label).toBe('2026-W38');
  });

  it('解析周、月、日', () => {
    expect(parseIsoWeek('2026-W39')?.start.toISOString()).toBe('2026-09-21T00:00:00.000Z');
    expect(parseIsoWeek('2026W1')?.start.toISOString()).toBe('2025-12-29T00:00:00.000Z');
    expect(parseIsoWeek('2026-W60')).toBeNull();
    expect(parseIsoWeek('abc')).toBeNull();
    expect(parseMonth('2026-02')?.end.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(monthRange(now).label).toBe('2026-09');
    expect(todayRange(now).label).toBe('2026-09-24（周四）');
  });

  it('解析 purge 的截止时间', () => {
    expect(parseCutoff('30d', now)?.toISOString()).toBe('2026-08-25T10:00:00.000Z');
    expect(parseCutoff('2w', now)?.toISOString()).toBe('2026-09-10T10:00:00.000Z');
    expect(parseCutoff('12h', now)?.toISOString()).toBe('2026-09-23T22:00:00.000Z');
    expect(parseCutoff('1y', now)?.toISOString()).toBe('2025-09-24T10:00:00.000Z');
    expect(parseCutoff('2026-01-01', now)?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(parseCutoff('yesterday', now)).toBeNull();
  });
});
