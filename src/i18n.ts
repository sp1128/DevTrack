/**
 * 输出语言。统计输出与报告支持中文（默认）和英文。
 *
 * 用法：L('开发时长', 'Active time')。语言在 CLI 启动时按
 * --lang 参数 > DEVTRACK_LANG 环境变量 > 配置 lang 的顺序确定。
 */
export const LANGS = ['zh', 'en'] as const;
export type Lang = (typeof LANGS)[number];

let current: Lang = 'zh';
let explicit = false;

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGS as readonly string[]).includes(value);
}

export function getLang(): Lang {
  return current;
}

/** 设置语言。explicit 为 true 时（来自 --lang 或环境变量），之后读取的配置不会再覆盖它。 */
export function setLang(lang: Lang, isExplicit = false): void {
  if (explicit && !isExplicit) return;
  current = lang;
  if (isExplicit) explicit = true;
}

/** 测试使用：恢复默认状态 */
export function resetLang(): void {
  current = 'zh';
  explicit = false;
}

/** 按当前语言选择文本 */
export function L(zh: string, en: string): string {
  return current === 'en' ? en : zh;
}
