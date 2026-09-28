import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { handleMessage, runStdioServer, type McpServerOptions } from '../../mcp/server.js';
import { INSTRUCTIONS, TOOLS } from '../../mcp/tools.js';
import { CliError } from '../context.js';
import { c } from '../format.js';

export const DEFAULT_MCP_NAME = 'devtrack-stats';
const SCOPES = ['user', 'local', 'project'] as const;

function serverOptions(): McpServerOptions {
  const pkg = createRequire(import.meta.url)('../../../package.json') as { version: string };
  return { name: 'devtrack', version: pkg.version, instructions: INSTRUCTIONS, tools: TOOLS };
}

/** Claude Code 启动的 MCP 服务器入口：stdout 只输出协议消息。 */
export async function runMcpServe(): Promise<void> {
  await runStdioServer(serverOptions());
}

/** 注册到 Claude Code 时使用的启动命令：当前 Node 可执行文件 + dist/cli.js 的绝对路径。 */
export function serverCommand(): string[] {
  return [process.execPath, fileURLToPath(new URL('../../cli.js', import.meta.url)), 'mcp'];
}

function checkScope(scope: string): void {
  if (!(SCOPES as readonly string[]).includes(scope)) throw new CliError(`--scope 只支持 ${SCOPES.join(' / ')}：${scope}`);
}

function runClaude(args: string[]): { ok: boolean; missing: boolean } {
  const result = spawnSync('claude', args, { stdio: 'inherit' });
  if (result.error) return { ok: false, missing: (result.error as NodeJS.ErrnoException).code === 'ENOENT' };
  return { ok: result.status === 0, missing: false };
}

function quote(arg: string): string {
  return /[\s"'$`\\]/.test(arg) ? `"${arg.replace(/(["\\$`])/g, '\\$1')}"` : arg;
}

export async function runMcpInstall(options: { name?: string; scope?: string }): Promise<number | void> {
  const name = options.name ?? DEFAULT_MCP_NAME;
  const scope = options.scope ?? 'user';
  checkScope(scope);
  const args = ['mcp', 'add', '--scope', scope, name, '--', ...serverCommand()];
  const r = runClaude(args);
  if (r.ok) {
    console.log(`${c.green('✔')} 已注册 MCP 服务器 ${name}（${scope} 范围）。重新启动 Claude Code 后即可使用，例如问 Claude："我这周在哪个项目上花的时间最多？"`);
    console.log(c.gray(`  检查连接：claude mcp get ${name}`));
    return;
  }
  if (r.missing) {
    console.log(c.yellow('没有找到 claude 命令，请手动运行：'));
  } else {
    console.log(c.yellow('claude mcp add 执行失败（可能已经存在同名服务器，可先运行 devtrack mcp uninstall）。手动注册的命令：'));
  }
  console.log(`  claude ${args.map(quote).join(' ')}`);
  const [command, ...rest] = serverCommand();
  console.log(c.gray('\n  或者把下面的配置加入项目的 .mcp.json 的 mcpServers 中：'));
  console.log(c.gray(`  ${JSON.stringify({ [name]: { command, args: rest } })}`));
  return 1;
}

export async function runMcpUninstall(options: { name?: string; scope?: string }): Promise<number | void> {
  const name = options.name ?? DEFAULT_MCP_NAME;
  const scope = options.scope ?? 'user';
  checkScope(scope);
  const args = ['mcp', 'remove', '--scope', scope, name];
  const r = runClaude(args);
  if (r.ok) {
    console.log(`${c.green('✔')} 已从 Claude Code 移除 MCP 服务器 ${name}`);
    return;
  }
  console.log(c.yellow(r.missing ? '没有找到 claude 命令，请手动运行：' : 'claude mcp remove 执行失败，手动运行：'));
  console.log(`  claude ${args.map(quote).join(' ')}`);
  return 1;
}

/** 在进程内走一遍 initialize → tools/list → 调用每个工具，确认服务器可用。 */
export async function runMcpTest(): Promise<number | void> {
  const options = serverOptions();
  let id = 0;
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const res = await handleMessage(options, { jsonrpc: '2.0', id: ++id, method, params });
    if (!res || 'error' in res) throw new CliError(`${method} 失败：${JSON.stringify(res?.error)}`);
    return res.result as Record<string, unknown>;
  };
  const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'devtrack-test', version: '0' } });
  console.log(`${c.green('✔')} initialize：协议版本 ${String(init.protocolVersion)}`);
  const list = (await call('tools/list')).tools as { name: string }[];
  console.log(`${c.green('✔')} tools/list：${list.length} 个工具（${list.map((t) => t.name).join(', ')}）`);
  let failed = 0;
  for (const tool of list) {
    const result = await call('tools/call', { name: tool.name, arguments: {} });
    const text = ((result.content as { text: string }[])[0]?.text ?? '').length;
    if (result.isError) {
      failed++;
      console.log(`${c.red('✖')} ${tool.name}：${(result.content as { text: string }[])[0]?.text}`);
    } else {
      console.log(`${c.green('✔')} ${tool.name}：返回 ${text} 个字符`);
    }
  }
  return failed > 0 ? 1 : undefined;
}
