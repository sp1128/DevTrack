/**
 * 从分支名、提交说明中提取工单号（例如 feature/AUTH-42-refresh-token -> AUTH-42）。
 *
 * 默认识别 Jira / Linear / YouTrack 风格的"大写前缀-数字"。可以通过配置 tickets.patterns
 * 自定义正则：有捕获组时取第一个捕获组，否则取整个匹配。
 */
export interface TicketOptions {
  /** 正则（字符串形式） */
  patterns: string[];
  /** 忽略大小写匹配，结果统一转为大写 */
  ignoreCase: boolean;
  /** 不当作工单的前缀，例如 UTF-8、SHA-256 */
  ignorePrefixes: string[];
}

export const DEFAULT_TICKET_PATTERN = '\\b[A-Z][A-Z0-9]{1,9}-\\d+\\b';

export const DEFAULT_TICKET_IGNORE = ['UTF', 'SHA', 'ISO', 'RFC', 'HTTP', 'TLS', 'SSL', 'AES', 'RSA', 'MD', 'ES', 'ECMA', 'WIN', 'X'];

export const DEFAULT_TICKET_OPTIONS: TicketOptions = {
  patterns: [DEFAULT_TICKET_PATTERN],
  ignoreCase: false,
  ignorePrefixes: DEFAULT_TICKET_IGNORE,
};

const cache = new Map<string, RegExp | null>();

function compile(pattern: string, ignoreCase: boolean): RegExp | null {
  const key = `${ignoreCase ? 'i' : ''}:${pattern}`;
  if (!cache.has(key)) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(pattern, ignoreCase ? 'gi' : 'g');
    } catch {
      // 非法正则忽略
    }
    cache.set(key, re);
  }
  return cache.get(key)!;
}

/** 提取文本中的工单号（去重，保持出现顺序）。 */
export function extractTickets(text: string | null | undefined, options: TicketOptions = DEFAULT_TICKET_OPTIONS): string[] {
  if (!text) return [];
  const found: string[] = [];
  const ignore = new Set(options.ignorePrefixes.map((p) => p.toUpperCase()));
  for (const pattern of options.patterns) {
    const re = compile(pattern, options.ignoreCase);
    if (!re) continue;
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      let id = (m[1] ?? m[0]).trim();
      if (!id) continue;
      if (options.ignoreCase) id = id.toUpperCase();
      const prefix = id.split('-')[0]!.toUpperCase();
      if (ignore.has(prefix)) continue;
      if (!found.includes(id)) found.push(id);
    }
  }
  return found;
}
