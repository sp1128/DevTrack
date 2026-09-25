/**
 * Claude 模型价格（美元 / 百万 token），用于从 token 用量估算费用。
 *
 * 来源：Anthropic 官方定价（2026-06）。已用 Claude Code 会话记录中的
 * cost-state（Claude Code 自己计算的费用）核对：Opus 5.5 与 Haiku 4.5 的计算结果一致。
 *
 * 缓存写入：5 分钟缓存按输入价格的 1.25 倍，1 小时缓存按 2 倍。
 * 价格表中没有的模型不估算费用（只统计 token）；可通过配置 usage.prices 补充或覆盖。
 */
export interface ModelPrice {
  input: number;
  output: number;
  /** 缓存读取价格；省略时按输入价格的 0.1 倍 */
  cacheRead?: number;
}

export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/**
 * 按最长前缀匹配模型价格：claude-haiku-4-5-20251001 -> claude-haiku-4-5。
 * 为避免 claude-opus-5 误匹配 claude-opus-5-5，前缀之后必须是结尾或 "-" + 数字日期 / 版本后缀。
 */
export function findPrice(model: string | null | undefined, overrides: Record<string, ModelPrice> = {}): ModelPrice | null {
  if (!model) return null;
  const table = { ...DEFAULT_PRICES, ...overrides };
  const name = model.toLowerCase().replace(/\[.*\]$/, '');
  let best: string | null = null;
  for (const key of Object.keys(table)) {
    const k = key.toLowerCase();
    if (name === k || (name.startsWith(k + '-') && /^\d{8}$/.test(name.slice(k.length + 1)))) {
      if (!best || k.length > best.length) best = key;
    }
  }
  return best ? table[best]! : null;
}

/** 估算费用（美元）；价格未知时返回 null。 */
export function estimateCost(model: string | null | undefined, t: TokenCounts, overrides?: Record<string, ModelPrice>): number | null {
  const price = findPrice(model, overrides);
  if (!price) return null;
  const cacheRead = price.cacheRead ?? price.input * 0.1;
  return (
    (t.input * price.input +
      t.output * price.output +
      t.cacheRead * cacheRead +
      t.cacheWrite5m * price.input * 1.25 +
      t.cacheWrite1h * price.input * 2) /
    1_000_000
  );
}
