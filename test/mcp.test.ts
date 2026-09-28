import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMcpInstall, serverCommand } from '../src/cli/commands/mcp.js';
import { defaultConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { handleMessage, LATEST_PROTOCOL_VERSION, runStdioServer, type McpServerOptions } from '../src/mcp/server.js';
import { TOOLS } from '../src/mcp/tools.js';
import { getPaths } from '../src/paths.js';
import { isolateEnv, send } from './helpers.js';

const options: McpServerOptions = {
  name: 'devtrack',
  version: '0.0.0',
  instructions: 'test',
  tools: [
    { name: 'echo', title: 'Echo', description: 'echo', inputSchema: { type: 'object' }, handler: (a) => JSON.stringify(a) },
    {
      name: 'boom',
      title: 'Boom',
      description: 'fails',
      inputSchema: { type: 'object' },
      handler: () => {
        throw new Error('something went wrong');
      },
    },
  ],
};

const req = (id: number, method: string, params?: Record<string, unknown>) => ({ jsonrpc: '2.0', id, method, params });

describe('MCP 协议', () => {
  it('initialize：协商协议版本', async () => {
    const ok = await handleMessage(options, req(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } }));
    expect(ok).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'devtrack', version: '0.0.0' },
        instructions: 'test',
      },
    });
    const unknown = await handleMessage(options, req(2, 'initialize', { protocolVersion: '2099-01-01' }));
    expect((unknown!.result as { protocolVersion: string }).protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('tools/list、tools/call、错误处理', async () => {
    expect(await handleMessage(options, req(1, 'ping'))).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    const list = (await handleMessage(options, req(2, 'tools/list')))!.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] };
    expect(list.tools.map((t) => t.name)).toEqual(['echo', 'boom']);
    expect(list.tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
    expect(await handleMessage(options, req(3, 'tools/call', { name: 'echo', arguments: { a: 1 } }))).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: { content: [{ type: 'text', text: '{"a":1}' }] },
    });
    // 工具内部错误作为 isError 结果返回给模型，而不是协议错误
    expect((await handleMessage(options, req(4, 'tools/call', { name: 'boom' })))!.result).toEqual({
      content: [{ type: 'text', text: 'something went wrong' }],
      isError: true,
    });
    expect((await handleMessage(options, req(5, 'tools/call', { name: 'nope' })))!.error).toMatchObject({ code: -32602 });
    expect((await handleMessage(options, req(6, 'tools/call', { name: 'echo', arguments: [1] })))!.error).toMatchObject({ code: -32602 });
    expect((await handleMessage(options, req(7, 'resources/list')))!.error).toMatchObject({ code: -32601 });
    expect(await handleMessage(options, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect((await handleMessage(options, [1, 2]))!.error).toMatchObject({ code: -32600 });
  });

  it('stdio：每行一条消息，非法 JSON 返回解析错误', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (d) => chunks.push(String(d)));
    const done = runStdioServer(options, input, output);
    input.write(JSON.stringify(req(1, 'ping')) + '\n');
    input.write('{broken\n\n');
    input.end(JSON.stringify(req(2, 'tools/call', { name: 'echo', arguments: { x: 'y' } })) + '\n');
    await done;
    const lines = chunks.join('').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines.find((l) => l.id === null).error.code).toBe(-32700);
    expect(lines.find((l) => l.id === 2).result.content[0].text).toBe('{"x":"y"}');
  });
});

describe('DevTrack MCP 工具', () => {
  let env: ReturnType<typeof isolateEnv>;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await handleMessage({ ...options, tools: TOOLS }, req(1, 'tools/call', { name, arguments: args }));
    const result = res!.result as { content: { text: string }[]; isError?: boolean };
    return { text: result.content[0]!.text, isError: result.isError ?? false };
  };

  beforeEach(() => {
    env = isolateEnv();
    const db = openDatabase(getPaths().dbFile);
    const config = defaultConfig();
    config.collect.git = false;
    const t = Date.now() - 20 * 60_000;
    for (const name of ['shop', 'blog']) {
      const cwd = path.join(env.home, name);
      fs.mkdirSync(cwd, { recursive: true });
      send(db, config, { session_id: name, hook_event_name: 'SessionStart', cwd }, new Date(t));
      send(db, config, { session_id: name, hook_event_name: 'PostToolUse', cwd, tool_name: 'Read', tool_input: {} }, new Date(t + 5 * 60_000));
    }
    db.prepare("UPDATE sessions SET summary = '实现购物车 AUTH-42' WHERE session_id = 'shop'").run();
    db.close();
  });
  afterEach(() => env.restore());

  it('get_activity_summary：全部项目与单个项目', async () => {
    const all = JSON.parse((await call('get_activity_summary', { period: 'today' })).text);
    expect(all.sessions).toBe(2);
    expect(all.projects.map((p: { name: string }) => p.name).sort()).toEqual(['blog', 'shop']);
    const shop = JSON.parse((await call('get_activity_summary', { project: 'SHOP' })).text);
    expect(shop.project).toBe('shop');
    expect(shop.sessions).toBe(1);
    expect(shop.sessionSummaries).toEqual([expect.objectContaining({ summary: '实现购物车 AUTH-42' })]);
    const missing = await call('get_activity_summary', { project: 'nope' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('Known projects');
    expect((await call('get_activity_summary', { period: 'decade' })).isError).toBe(true);
    expect((await call('get_activity_summary', { date: '2026/01/01' })).isError).toBe(true);
  });

  it('search_sessions、list_projects、get_standup、get_token_usage', async () => {
    const found = JSON.parse((await call('search_sessions', { query: 'auth-42' })).text);
    expect(found.total).toBe(1);
    expect(found.sessions[0].project).toBe('shop');
    const projects = JSON.parse((await call('list_projects')).text);
    expect(projects).toHaveLength(2);
    const standup = JSON.parse((await call('get_standup')).text);
    expect(standup.text).toContain('站会');
    expect(standup.data.today.projects).toHaveLength(2);
    const tokens = JSON.parse((await call('get_token_usage')).text);
    expect(tokens.tokens).toBeNull();
    expect(tokens.note).toContain('collect.tokenUsage');
  });
});

describe('mcp install', () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => void logs.push(a.join(' ')));
  });
  afterEach(() => vi.restoreAllMocks());

  it('找不到 claude 命令时打印手动注册命令并返回 1', async () => {
    const saved = process.env.PATH;
    process.env.PATH = '';
    try {
      expect(await runMcpInstall({})).toBe(1);
    } finally {
      process.env.PATH = saved;
    }
    const out = logs.join('\n');
    expect(out).toContain('没有找到 claude 命令');
    expect(out).toContain('mcp add --scope user devtrack-stats --');
    expect(out).toContain('"devtrack-stats"');
    expect(serverCommand().at(-1)).toBe('mcp');
    await expect(runMcpInstall({ scope: 'global' })).rejects.toThrow(/--scope/);
  });
});
