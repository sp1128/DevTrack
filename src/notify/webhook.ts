import { createHmac } from 'node:crypto';

/**
 * 把站会摘要、周报推送到聊天工具的 Webhook（群机器人）。
 *
 * 各平台的请求格式：
 * - slack：{"text": ...}，成功时返回 "ok"
 * - discord：{"content": ...}，最多 2000 个字符
 * - feishu（飞书）：{"msg_type": "text", "content": {"text": ...}}，HTTP 200 且 code = 0 为成功
 * - dingtalk（钉钉）：{"msgtype": "text", "text": {"content": ...}}，errcode = 0 为成功；
 *   开启"加签"时在 URL 上附加 timestamp（毫秒）与 sign = base64(HMAC-SHA256(secret, `${timestamp}\n${secret}`))
 * - wecom（企业微信）：{"msgtype": "text", "text": {"content": ...}}，errcode = 0 为成功，文本最长 2048 字节
 * - webhook：通用 JSON {source, kind, title, text, data}
 */
export const NOTIFY_TYPES = ['slack', 'discord', 'feishu', 'dingtalk', 'wecom', 'webhook'] as const;
export type NotifyType = (typeof NOTIFY_TYPES)[number];

export interface NotifyTarget {
  type: NotifyType;
  /** Webhook 地址（与 urlEnv 二选一） */
  url?: string;
  /** 从该环境变量读取 Webhook 地址，避免写入配置文件 */
  urlEnv?: string;
  /** 钉钉"加签"密钥（与 secretEnv 二选一） */
  secret?: string;
  secretEnv?: string;
  /** 便于识别的名称 */
  name?: string;
}

export interface NotifyMessage {
  kind: 'standup' | 'report' | 'test';
  title: string;
  /** 纯文本正文（不含标题） */
  text: string;
  /** 通用 webhook 附带的结构化数据 */
  data?: unknown;
}

export class NotifyError extends Error {}

export interface NotifyDeps {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  timeoutMs?: number;
}

/** 各平台正文长度上限（保守取值）。 */
const MAX_CHARS: Partial<Record<NotifyType, number>> = { discord: 2000, feishu: 18000, dingtalk: 18000, slack: 35000 };
const WECOM_MAX_BYTES = 2048;

function truncateChars(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 2) + '\n…';
}

function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let out = text;
  while (Buffer.byteLength(out + '\n…', 'utf8') > maxBytes) out = out.slice(0, Math.floor(out.length * 0.9));
  return out + '\n…';
}

/** 钉钉加签：返回附加到 URL 上的 timestamp 与 sign（已 URL 编码）。 */
export function dingtalkSign(secret: string, timestampMs: number): { timestamp: string; sign: string } {
  const timestamp = String(timestampMs);
  const sign = createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64');
  return { timestamp, sign: encodeURIComponent(sign) };
}

function resolveValue(direct: string | undefined, envName: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (direct) return direct;
  if (envName) {
    const v = env[envName]?.trim();
    if (v) return v;
  }
  return undefined;
}

/** 显示用的目标描述，隐藏地址中的令牌。 */
export function describeTarget(target: NotifyTarget, index?: number): string {
  const label = target.name ? `${target.name}（${target.type}）` : target.type;
  let where: string;
  if (target.urlEnv && !target.url) where = `$${target.urlEnv}`;
  else {
    try {
      const u = new URL(target.url ?? '');
      where = `${u.host}/…${(u.pathname + u.search).slice(-4)}`;
    } catch {
      where = '(无效地址)';
    }
  }
  return `${index !== undefined ? `#${index + 1} ` : ''}${label} → ${where}`;
}

/** 构造请求地址与请求体。 */
export function buildRequest(
  target: NotifyTarget,
  message: NotifyMessage,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): { url: string; body: string } {
  const base = resolveValue(target.url, target.urlEnv, env);
  if (!base) throw new NotifyError(target.urlEnv ? `环境变量 ${target.urlEnv} 未设置` : '缺少 Webhook 地址');
  const full = `${message.title}\n\n${message.text}`.trim();
  const limited = MAX_CHARS[target.type] ? truncateChars(full, MAX_CHARS[target.type]!) : full;
  let url = base;
  let payload: unknown;
  switch (target.type) {
    case 'slack':
      payload = { text: limited };
      break;
    case 'discord':
      payload = { content: limited };
      break;
    case 'feishu':
      payload = { msg_type: 'text', content: { text: limited } };
      break;
    case 'dingtalk': {
      payload = { msgtype: 'text', text: { content: limited } };
      const secret = resolveValue(target.secret, target.secretEnv, env);
      if (secret) {
        const { timestamp, sign } = dingtalkSign(secret, now.getTime());
        url += `${url.includes('?') ? '&' : '?'}timestamp=${timestamp}&sign=${sign}`;
      }
      break;
    }
    case 'wecom':
      payload = { msgtype: 'text', text: { content: truncateBytes(full, WECOM_MAX_BYTES) } };
      break;
    case 'webhook':
      payload = { source: 'devtrack', kind: message.kind, title: message.title, text: message.text, data: message.data ?? null };
      break;
  }
  return { url, body: JSON.stringify(payload) };
}

/** 发送到一个目标；失败时抛出 NotifyError（信息中不包含地址）。 */
export async function sendToTarget(target: NotifyTarget, message: NotifyMessage, deps: NotifyDeps = {}): Promise<void> {
  const { url, body } = buildRequest(target, message, deps.env ?? process.env, deps.now?.() ?? new Date());
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body,
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
    });
  } catch (err) {
    throw new NotifyError(`请求失败：${(err as Error).message}`);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new NotifyError(`HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`);
  // 飞书、钉钉、企业微信出错时也可能返回 HTTP 200，需要检查返回的错误码
  if (target.type === 'feishu' || target.type === 'dingtalk' || target.type === 'wecom') {
    let data: { code?: number; msg?: string; errcode?: number; errmsg?: string } | null = null;
    try {
      data = JSON.parse(text);
    } catch {
      // 非 JSON 响应按成功处理
    }
    const code = data?.code ?? data?.errcode;
    if (typeof code === 'number' && code !== 0) {
      throw new NotifyError(`返回错误 ${code}：${data?.msg ?? data?.errmsg ?? ''}`.trim());
    }
  }
}

export interface SendResult {
  target: string;
  ok: boolean;
  error?: string;
}

/** 依次发送到所有目标，返回每个目标的结果（不会抛出异常）。 */
export async function sendAll(targets: NotifyTarget[], message: NotifyMessage, deps: NotifyDeps = {}): Promise<SendResult[]> {
  const results: SendResult[] = [];
  for (const [i, target] of targets.entries()) {
    const label = describeTarget(target, i);
    try {
      await sendToTarget(target, message, deps);
      results.push({ target: label, ok: true });
    } catch (err) {
      results.push({ target: label, ok: false, error: (err as Error).message });
    }
  }
  return results;
}
