import { describe, expect, it } from 'vitest';
import { parseIsoWeek } from '../src/core/time.js';
import { AiError, buildAiPayload, generateAiSummary, type AnthropicLike } from '../src/report/ai.js';
import { collectPeriodStats, type PeriodStats } from '../src/stats/queries.js';
import { memoryDb, testConfig } from './helpers.js';

function sampleStats(): PeriodStats {
  const db = memoryDb();
  const stats = collectPeriodStats(db, parseIsoWeek('2026-W39')!, { idleMinutes: 30 });
  db.close();
  stats.projects = [
    {
      id: 1,
      name: 'alpha',
      path: '/home/me/secret-location/alpha',
      gitRemote: null,
      activeSeconds: 3600,
      sessions: 2,
      commits: 3,
      insertions: 10,
      deletions: 2,
      files: 4,
      fileEdits: 9,
      commands: 5,
      commandFailures: 1,
      tasksCompleted: 1,
    },
  ];
  stats.files.top = [{ projectId: 1, projectName: 'alpha', path: 'src/internal/payroll.ts', edits: 3, lastAction: 'modify', created: false }];
  stats.commands.failures = [
    { command: 'DB_PASSWORD=[REDACTED] npm test', category: 'test', projectName: 'alpha', count: 2, lastExitCode: 1, lastAt: '' },
  ];
  stats.tasks.completed = [
    { title: '实现登录', projectName: 'alpha', status: 'completed', source: 'task', createdAt: '', completedAt: '' },
  ];
  return stats;
}

function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return respond(String(url), init!);
  }) as typeof fetch;
  return { fn, calls };
}

describe('AI 周报', () => {
  it('发送的数据只包含统计与任务摘要：不含路径、命令原文', () => {
    const stats = sampleStats();
    const payload = buildAiPayload(stats, testConfig());
    const text = JSON.stringify(payload);
    expect(text).toContain('实现登录');
    expect(text).toContain('"activeHours":1');
    expect(text).not.toContain('secret-location');
    expect(text).not.toContain('payroll');
    expect(text).not.toContain('npm test');
    const withPaths = JSON.stringify(buildAiPayload(stats, testConfig((c) => (c.ai.includeFilePaths = true))));
    expect(withPaths).toContain('src/internal/payroll.ts');
  });

  it('DeepSeek：默认模型与地址，Bearer 认证', async () => {
    const { fn, calls } = fakeFetch(() =>
      Response.json({ model: 'deepseek-chat', choices: [{ message: { content: '### 本周工作概述\n不错' } }] }),
    );
    const config = testConfig((c) => (c.ai.provider = 'deepseek'));
    const result = await generateAiSummary(sampleStats(), config, { fetch: fn, env: { DEEPSEEK_API_KEY: 'ds-key' } });
    expect(result).toEqual({ text: '### 本周工作概述\n不错', provider: 'deepseek', model: 'deepseek-chat' });
    expect(calls[0]!.url).toBe('https://api.deepseek.com/chat/completions');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer ds-key');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe('deepseek-chat');
    expect(body.messages[0].role).toBe('system');
  });

  it('OpenAI 兼容接口：自定义地址、模型与 Key 环境变量', async () => {
    const { fn, calls } = fakeFetch(() => Response.json({ choices: [{ message: { content: 'ok' } }] }));
    const config = testConfig((c) => {
      c.ai.provider = 'openai-compatible';
      c.ai.baseUrl = 'http://localhost:11434/v1/';
      c.ai.model = 'qwen3';
      c.ai.apiKeyEnv = 'MY_KEY';
    });
    const result = await generateAiSummary(sampleStats(), config, { fetch: fn, env: { MY_KEY: 'k' } });
    expect(result.model).toBe('qwen3');
    expect(calls[0]!.url).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('配置不完整或接口出错时给出明确原因', async () => {
    const stats = sampleStats();
    await expect(
      generateAiSummary(stats, testConfig((c) => (c.ai.provider = 'deepseek')), { env: {} }),
    ).rejects.toThrow(/DEEPSEEK_API_KEY/);
    await expect(
      generateAiSummary(stats, testConfig((c) => (c.ai.provider = 'openai')), { env: { OPENAI_API_KEY: 'x' } }),
    ).rejects.toThrow(/ai.model/);
    const { fn } = fakeFetch(() => new Response('{"error":"bad key"}', { status: 401 }));
    await expect(
      generateAiSummary(stats, testConfig((c) => (c.ai.provider = 'deepseek')), { fetch: fn, env: { DEEPSEEK_API_KEY: 'x' } }),
    ).rejects.toThrow(AiError);
  });

  it('Anthropic：通过官方 SDK 调用，默认 claude-opus-5 并开启服务端拒答回退', async () => {
    const calls: Record<string, unknown>[] = [];
    let clientOptions: Record<string, unknown> = {};
    const client: AnthropicLike = {
      beta: {
        messages: {
          create: async (params) => {
            calls.push(params);
            return { stop_reason: 'end_turn', model: 'claude-opus-5', content: [{ type: 'text', text: '总结内容' }] };
          },
        },
      },
    };
    const deps = {
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      createAnthropic: async (options: { apiKey?: string; baseURL?: string; timeout: number }) => {
        clientOptions = options;
        return client;
      },
    };
    const result = await generateAiSummary(sampleStats(), testConfig(), deps);
    expect(result).toEqual({ text: '总结内容', provider: 'anthropic', model: 'claude-opus-5' });
    expect(clientOptions).toMatchObject({ apiKey: 'sk-test', timeout: 120_000 });
    expect(calls[0]).toMatchObject({
      model: 'claude-opus-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });

    // 自定义网关地址时不发送 beta 参数
    await generateAiSummary(sampleStats(), testConfig((c) => (c.ai.baseUrl = 'https://gateway.example.com')), deps);
    expect(calls[1]!.fallbacks).toBeUndefined();

    // 拒答时报错
    client.beta.messages.create = async () => ({ stop_reason: 'refusal', model: 'claude-opus-5', content: [] });
    await expect(generateAiSummary(sampleStats(), testConfig(), deps)).rejects.toThrow(/refusal/);
  });
});
