import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTempDir, rmrf } from './helpers.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

describe('会话摘要端到端：SessionEnd 后台生成（dist/cli.js）', () => {
  let root: string;
  let home: string;
  let env: NodeJS.ProcessEnv;
  let server: http.Server;
  const requests: { auth?: string; body: { model: string; messages: { role: string; content: string }[] } }[] = [];

  const run = (args: string[], input?: string) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, input, encoding: 'utf8', timeout: 30_000 });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const hook = (payload: Record<string, unknown>) => run(['hook'], JSON.stringify(payload));

  beforeAll(async () => {
    if (!fs.existsSync(CLI)) throw new Error('dist/cli.js 不存在，请先运行 npm run build');
    // 本地假的 OpenAI 兼容接口
    server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        requests.push({ auth: req.headers.authorization, body: JSON.parse(data) });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ model: 'fake-model', choices: [{ message: { content: '实现了购物车功能' } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    root = makeTempDir();
    home = path.join(root, 'devtrack');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(root, 'shop'));
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({
        collect: { git: false },
        ai: {
          provider: 'openai-compatible',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          sessionSummaryModel: 'fake-model',
          sessionSummary: true,
        },
      }),
    );
    env = { ...process.env, DEVTRACK_HOME: home, DEVTRACK_AI_API_KEY: 'local-key', NO_COLOR: '1' };
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmrf(root);
  });

  it('会话结束后自动生成摘要，Hook 本身立即返回', async () => {
    const cwd = path.join(root, 'shop');
    expect(hook({ session_id: 's1', hook_event_name: 'SessionStart', cwd }).code).toBe(0);
    hook({
      session_id: 's1',
      hook_event_name: 'PostToolUse',
      cwd,
      tool_name: 'Write',
      tool_input: { file_path: path.join(cwd, 'cart.ts') },
      tool_response: { type: 'create' },
    });
    const started = Date.now();
    const end = hook({ session_id: 's1', hook_event_name: 'SessionEnd', cwd, reason: 'other' });
    expect(end.code).toBe(0);
    expect(end.stdout).toBe('');
    expect(Date.now() - started).toBeLessThan(5000);

    // 等待后台进程写入摘要
    const db = new Database(path.join(home, 'devtrack.db'), { readonly: true });
    let summary: string | null = null;
    for (let i = 0; i < 100 && !summary; i++) {
      await new Promise((r) => setTimeout(r, 100));
      summary = (db.prepare("SELECT summary FROM sessions WHERE session_id = 's1'").get() as { summary: string | null }).summary;
    }
    db.close();
    expect(summary).toBe('实现了购物车功能');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.auth).toBe('Bearer local-key');
    expect(requests[0]!.body.model).toBe('fake-model');
    expect(requests[0]!.body.messages[1]!.content).not.toContain('cart.ts');

    const today = run(['today', '--no-sync']);
    expect(today.stdout).toContain('实现了购物车功能');
  });

  it('summarize 命令：dry-run 只打印数据；没有待处理会话时给出提示', () => {
    const dry = run(['summarize', '--force', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({ project: 'shop', files: { modified: 1 } });
    expect(requests).toHaveLength(1);
    const none = run(['summarize']);
    expect(none.code).toBe(0);
    expect(none.stdout).toContain('没有需要生成摘要的会话');
  });
});
