import { redact } from './redact.js';

/** 脱敏 + 合并空白 + 截断，用于提交信息、任务标题等短文本。 */
export function sanitizeText(text: string, maxLength: number, extraPatterns?: string[]): string {
  let out = redact(text, { extraPatterns }).replace(/\s+/g, ' ').trim();
  if (out.length > maxLength) out = out.slice(0, maxLength - 1).trimEnd() + '…';
  return out;
}

/**
 * 从用户提示词生成简短的会话标题（仅在 collect.promptSummary 开启时使用）：
 * 去掉粘贴内容块，取第一行非空文本，脱敏后截断到 80 个字符。
 */
export function summarizePrompt(prompt: string, extraPatterns?: string[]): string | null {
  const withoutPasted = prompt.replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, ' ');
  const line = withoutPasted
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  return sanitizeText(line, 80, extraPatterns);
}
