import { createInterface } from 'node:readline';

/**
 * 最小的 MCP（Model Context Protocol）stdio 服务器。
 *
 * 传输：每行一条 JSON-RPC 2.0 消息（与 MCP TypeScript SDK 的 stdio 传输相同）。
 * 只实现只读工具所需的方法：initialize、ping、tools/list、tools/call。
 * 协议版本协商与 SDK 相同：客户端请求的版本受支持时原样返回，否则返回最新版本。
 *
 * 不使用 @modelcontextprotocol/sdk：它依赖 express 等服务端组件，对一个 CLI 来说太重。
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]!;

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 返回文本结果；抛出异常时作为工具错误（isError）返回给模型 */
  handler: (args: Record<string, unknown>) => Promise<string> | string;
}

export interface McpServerOptions {
  name: string;
  version: string;
  instructions?: string;
  tools: McpTool[];
}

type JsonRpcId = string | number | null;
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;

class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

/** 处理一条消息，返回响应（通知返回 null）。 */
export async function handleMessage(options: McpServerOptions, message: unknown): Promise<Record<string, unknown> | null> {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return { jsonrpc: '2.0', id: null, error: { code: ERR_INVALID_REQUEST, message: 'Invalid Request' } };
  }
  const msg = message as JsonRpcMessage;
  const isRequest = msg.id !== undefined && msg.id !== null;
  if (typeof msg.method !== 'string') {
    // 客户端发来的响应（本服务器不发请求）或非法消息，忽略
    return isRequest ? { jsonrpc: '2.0', id: msg.id, error: { code: ERR_INVALID_REQUEST, message: 'Invalid Request' } } : null;
  }
  if (!isRequest) return null; // notifications/initialized、notifications/cancelled 等
  try {
    const result = await dispatch(options, msg.method, msg.params ?? {});
    return { jsonrpc: '2.0', id: msg.id, result };
  } catch (err) {
    const code = err instanceof RpcError ? err.code : ERR_INTERNAL;
    return { jsonrpc: '2.0', id: msg.id, error: { code, message: (err as Error).message } };
  }
}

async function dispatch(options: McpServerOptions, method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      const protocolVersion =
        typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
      return {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: options.name, version: options.version },
        ...(options.instructions ? { instructions: options.instructions } : {}),
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return {
        tools: options.tools.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        })),
      };
    case 'tools/call': {
      const name = params.name;
      const tool = options.tools.find((t) => t.name === name);
      if (!tool) throw new RpcError(ERR_INVALID_PARAMS, `Unknown tool: ${String(name)}`);
      const args = params.arguments;
      if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
        throw new RpcError(ERR_INVALID_PARAMS, 'arguments must be an object');
      }
      try {
        const text = await tool.handler((args as Record<string, unknown>) ?? {});
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
    default:
      throw new RpcError(ERR_METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/** 在 stdin / stdout 上运行服务器，直到输入结束。日志只写 stderr。 */
export async function runStdioServer(
  options: McpServerOptions,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const pending: Promise<void>[] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: ERR_PARSE, message: 'Parse error' } }) + '\n');
      continue;
    }
    // 请求可以并发处理，响应按完成顺序写出（JSON-RPC 用 id 对应）
    pending.push(
      handleMessage(options, message).then((response) => {
        if (response) output.write(JSON.stringify(response) + '\n');
      }),
    );
  }
  await Promise.all(pending);
}
