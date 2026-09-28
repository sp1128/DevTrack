import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runNotifyAdd, runNotifyList, runNotifyRemove, runNotifyTest } from '../src/cli/commands/notify.js';
import { runReport } from '../src/cli/commands/report.js';
import { runStandup } from '../src/cli/commands/standup.js';
import { ConfigSchema, defaultConfig, loadConfig } from '../src/config.js';
import { parseConfigLite } from '../src/configLite.js';
import { openDatabase } from '../src/db/database.js';
import {
  buildRequest,
  describeTarget,
  dingtalkSign,
  sendAll,
  sendToTarget,
  type NotifyMessage,
  type NotifyTarget,
} from '../src/notify/webhook.js';
import { getPaths } from '../src/paths.js';
import { isolateEnv, send } from './helpers.js';

const message: NotifyMessage = { kind: 'test', title: 'DevTrack 标题', text: '正文' };

describe('Webhook 请求格式', () => {
  it('钉钉加签与 Python hmac 计算结果一致', () => {
    // python: base64(hmac.new(secret, f"{ts}\n{secret}", sha256)) 再 URL 编码
    expect(dingtalkSign('SEC0123456789abcdef', 1700000000000)).toEqual({
      timestamp: '1700000000000',
      sign: 'TSZbRFUuvaSQaRKUpF970OPCb2%2FLcQAP3wOvwZIzBZk%3D',
    });
  });

  it('各平台的请求体', () => {
    const body = (t: NotifyTarget) => JSON.parse(buildRequest(t, message, {}).body);
    expect(body({ type: 'slack', url: 'https://hooks.slack.com/services/x' })).toEqual({ text: 'DevTrack 标题\n\n正文' });
    expect(body({ type: 'discord', url: 'https://discord.com/api/webhooks/x' })).toEqual({ content: 'DevTrack 标题\n\n正文' });
    expect(body({ type: 'feishu', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' })).toEqual({
      msg_type: 'text',
      content: { text: 'DevTrack 标题\n\n正文' },
    });
    expect(body({ type: 'dingtalk', url: 'https://oapi.dingtalk.com/robot/send?access_token=x' })).toEqual({
      msgtype: 'text',
      text: { content: 'DevTrack 标题\n\n正文' },
    });
    expect(body({ type: 'wecom', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x' })).toEqual({
      msgtype: 'text',
      text: { content: 'DevTrack 标题\n\n正文' },
    });
    expect(body({ type: 'webhook', url: 'https://example.com/hook' })).toEqual({
      source: 'devtrack',
      kind: 'test',
      title: 'DevTrack 标题',
      text: '正文',
      data: null,
    });
  });

  it('钉钉加签附加到 URL；环境变量读取地址与密钥', () => {
    const now = new Date(1700000000000);
    const { url } = buildRequest(
      { type: 'dingtalk', urlEnv: 'DT_URL', secretEnv: 'DT_SECRET' },
      message,
      { DT_URL: 'https://oapi.dingtalk.com/robot/send?access_token=abc', DT_SECRET: 'SEC0123456789abcdef' },
      now,
    );
    expect(url).toBe(
      'https://oapi.dingtalk.com/robot/send?access_token=abc&timestamp=1700000000000&sign=TSZbRFUuvaSQaRKUpF970OPCb2%2FLcQAP3wOvwZIzBZk%3D',
    );
    expect(() => buildRequest({ type: 'slack', urlEnv: 'MISSING' }, message, {})).toThrow(/MISSING/);
  });

  it('按平台限制截断', () => {
    const long: NotifyMessage = { ...message, text: '字'.repeat(5000) };
    expect(JSON.parse(buildRequest({ type: 'discord', url: 'https://d/x' }, long, {}).body).content.length).toBeLessThanOrEqual(2000);
    const wecom = JSON.parse(buildRequest({ type: 'wecom', url: 'https://w/x' }, long, {}).body).text.content;
    expect(Buffer.byteLength(wecom, 'utf8')).toBeLessThanOrEqual(2048);
  });

  it('地址中的令牌不会显示', () => {
    const d = describeTarget({ type: 'feishu', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdef123456', name: '团队群' }, 0);
    expect(d).toBe('#1 团队群（feishu） → open.feishu.cn/…3456');
    expect(d).not.toContain('abcdef');
    expect(describeTarget({ type: 'slack', urlEnv: 'SLACK_URL' })).toBe('slack → $SLACK_URL');
  });
});

describe('发送与错误处理', () => {
  const fakeFetch = (status: number, body: string) =>
    (async () => new Response(body, { status })) as unknown as typeof fetch;

  it('飞书 / 钉钉 / 企业微信在 HTTP 200 时也检查错误码', async () => {
    await expect(sendToTarget({ type: 'feishu', url: 'https://f/x' }, message, { fetch: fakeFetch(200, '{"code":0,"msg":"success"}') })).resolves.toBeUndefined();
    await expect(sendToTarget({ type: 'feishu', url: 'https://f/x' }, message, { fetch: fakeFetch(200, '{"code":19021,"msg":"sign match fail"}') })).rejects.toThrow(
      /19021.*sign match fail/,
    );
    await expect(sendToTarget({ type: 'dingtalk', url: 'https://d/x' }, message, { fetch: fakeFetch(200, '{"errcode":310000,"errmsg":"keywords not in content"}') })).rejects.toThrow(/310000/);
    await expect(sendToTarget({ type: 'wecom', url: 'https://w/x' }, message, { fetch: fakeFetch(200, '{"errcode":0,"errmsg":"ok"}') })).resolves.toBeUndefined();
    await expect(sendToTarget({ type: 'slack', url: 'https://s/x' }, message, { fetch: fakeFetch(404, 'no_service') })).rejects.toThrow(/HTTP 404/);
  });

  it('sendAll 返回每个目标的结果，错误信息不含地址', async () => {
    let n = 0;
    const fetchFn = (async () => (n++ === 0 ? new Response('ok') : new Response('bad', { status: 500 }))) as unknown as typeof fetch;
    const results = await sendAll(
      [
        { type: 'slack', url: 'https://hooks.slack.com/services/SECRET1' },
        { type: 'webhook', url: 'https://example.com/hook?token=SECRET2' },
      ],
      message,
      { fetch: fetchFn },
    );
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(JSON.stringify(results)).not.toMatch(/SECRET/);
  });
});

describe('notify 命令与 --send', () => {
  let env: ReturnType<typeof isolateEnv>;
  let server: http.Server;
  let port: number;
  let received: { path: string; body: Record<string, unknown> }[] = [];
  let logs: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        received.push({ path: req.url ?? '', body: JSON.parse(data) });
        res.statusCode = req.url?.includes('fail') ? 500 : 200;
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => {
    env = isolateEnv();
    received = [];
    logs = [];
    const capture = (...args: unknown[]) => void logs.push(args.join(' '));
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => (logs.push(String(chunk)), true)) as typeof process.stdout.write);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    env.restore();
  });

  it('add / list / remove 与配置校验', async () => {
    await runNotifyAdd('webhook', `http://127.0.0.1:${port}/a`, { name: 'local' });
    await runNotifyAdd('dingtalk', undefined, { urlEnv: 'DT_URL', secretEnv: 'DT_SECRET' });
    await expect(runNotifyAdd('teams', 'https://x', {})).rejects.toThrow(/类型只支持/);
    await expect(runNotifyAdd('slack', 'ftp://x', {})).rejects.toThrow(/推送目标无效/);
    await expect(runNotifyAdd('slack', undefined, {})).rejects.toThrow(/Webhook 地址/);
    await expect(runNotifyAdd('slack', 'https://x', { secret: 's' })).rejects.toThrow(/钉钉/);
    await expect(runNotifyAdd('webhook', 'https://x', { name: 'local' })).rejects.toThrow(/已经有名为/);
    const config = loadConfig(getPaths().configFile);
    expect(config.notify.targets).toEqual([
      { type: 'webhook', url: `http://127.0.0.1:${port}/a`, name: 'local' },
      { type: 'dingtalk', urlEnv: 'DT_URL', secretEnv: 'DT_SECRET' },
    ]);
    // Hook 的轻量配置解析遇到推送目标时退回 zod
    expect(parseConfigLite(JSON.parse(fs.readFileSync(getPaths().configFile, 'utf8')))).toBeNull();
    await runNotifyList();
    expect(logs.join('\n')).toContain('#2 dingtalk → $DT_URL');
    await runNotifyRemove('2');
    await runNotifyRemove('local');
    expect(loadConfig(getPaths().configFile).notify.targets).toEqual([]);
    await expect(runNotifyRemove('9')).rejects.toThrow(/没有找到/);
  });

  it('notify test、standup --send、report --send 推送到本地 Webhook', async () => {
    await expect(runNotifyTest()).rejects.toThrow(/还没有配置推送目标/);
    await runNotifyAdd('webhook', `http://127.0.0.1:${port}/ok`, {});
    expect(await runNotifyTest()).toBeUndefined();
    expect(received[0]!.body).toMatchObject({ source: 'devtrack', kind: 'test' });

    // 准备一点今天的数据
    const db = openDatabase(getPaths().dbFile);
    const cwd = path.join(env.home, 'shop');
    fs.mkdirSync(cwd, { recursive: true });
    const config = { ...defaultConfig(), collect: { ...defaultConfig().collect, git: false } };
    const t = Date.now() - 10 * 60_000;
    send(db, config, { session_id: 's', hook_event_name: 'SessionStart', cwd }, new Date(t));
    send(db, config, { session_id: 's', hook_event_name: 'PostToolUse', cwd, tool_name: 'Read', tool_input: {} }, new Date(t + 60_000));
    db.close();

    expect(await runStandup({ send: true, sync: false })).toBeUndefined();
    const standup = received[1]!.body as { kind: string; title: string; text: string };
    expect(standup.kind).toBe('standup');
    expect(standup.title).toMatch(/^DevTrack 站会 · /);
    expect(standup.text).toContain('shop');

    expect(await runReport({ send: true, sync: false, stdout: true })).toBeUndefined();
    const report = received[2]!.body as { kind: string; title: string; data: { sessions: number } };
    expect(report.kind).toBe('report');
    expect(report.title).toMatch(/^DevTrack 周报 · /);
    expect(report.data.sessions).toBe(1);

    // 推送失败时返回非零退出码
    await runNotifyAdd('webhook', `http://127.0.0.1:${port}/fail`, {});
    expect(await runNotifyTest()).toBe(1);
    expect(ConfigSchema.safeParse(JSON.parse(fs.readFileSync(getPaths().configFile, 'utf8'))).success).toBe(true);
  });
});
