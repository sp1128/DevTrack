/**
 * 敏感信息脱敏。
 *
 * 所有写入数据库的自由文本（命令、提交信息、任务标题、会话标题）都会经过这里。
 * 规则按顺序执行，替换结果统一为 [REDACTED]，重复执行是幂等的。
 */

export const REDACTED = '[REDACTED]';

/** 视为敏感的键名片段（用于 key=value、JSON、命令行参数等）。 */
const SENSITIVE_KEY =
  '[A-Za-z0-9_.-]*?(?:passw(?:or)?d|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?key|private[_-]?key|client[_-]?secret|session[_-]?id|cookie|credentials?|signature)[A-Za-z0-9_.-]*';

type Rule = { name: string; pattern: RegExp; replace: string | ((...args: string[]) => string) };

const RULES: Rule[] = [
  {
    name: 'private-key-block',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replace: '[REDACTED PRIVATE KEY]',
  },
  {
    // Authorization: Bearer xxx -> Authorization: [REDACTED]
    name: 'http-header',
    pattern:
      /\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-Api-Key|X-Auth-Token|X-Access-Token|Api-Key|PRIVATE-TOKEN|X-Goog-Api-Key|anthropic-api-key|openai-api-key)(\s*:\s*)[^'"\r\n]+/gi,
    replace: (_m, name, sep) => `${name}${sep.includes(' ') ? ': ' : ':'}${REDACTED}`,
  },
  {
    name: 'bearer',
    pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g,
    replace: (_m, scheme) => `${scheme} ${REDACTED}`,
  },
  {
    // https://user:pass@host 或 https://token@host
    name: 'url-credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@'"]+)(:[^/\s@'"]*)?@/gi,
    replace: (_m, scheme) => `${scheme}${REDACTED}@`,
  },
  {
    // 常见服务的令牌格式
    name: 'known-tokens',
    pattern: new RegExp(
      [
        String.raw`\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}`,
        String.raw`\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}`,
        String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
        String.raw`\bglpat-[A-Za-z0-9_-]{20,}`,
        String.raw`\bxox[abposr]-[A-Za-z0-9-]{10,}`,
        String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`,
        String.raw`\bAIza[0-9A-Za-z_-]{35}\b`,
        String.raw`\bnpm_[A-Za-z0-9]{36}\b`,
        String.raw`\bhf_[A-Za-z0-9]{30,}\b`,
        String.raw`\b(?:rk|pk|sk)_(?:live|test)_[A-Za-z0-9]{16,}`,
        String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`,
      ].join('|'),
      'g',
    ),
    replace: REDACTED,
  },
  {
    // --password xxx / --token=xxx / --api-key "xxx"
    name: 'cli-flags',
    pattern:
      /((?:^|[\s"'])--?(?:password|passwd|passphrase|pass|token|api-?key|api_key|secret|client-secret|access-token|auth-token|auth|private-key|credentials?|key)(?:=|\s+))("[^"]*"|'[^']*'|[^\s"'|;&]+)/gi,
    replace: (_m, flag) => `${flag}${REDACTED}`,
  },
  {
    // curl -u user:pass / --user user:pass
    name: 'basic-auth-flag',
    pattern: /((?:^|\s)(?:-u|--user)(?:=|\s+))(["']?)([^\s:'"]+):([^\s'"]+)\2/g,
    replace: (_m, flag, quote, user) => `${flag}${quote}${user}:${REDACTED}${quote}`,
  },
  {
    // mysql -pSECRET
    name: 'mysql-password',
    pattern: /(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^|;&\n]*?\s-p)(?!\s)([^\s|;&]+)/g,
    replace: (_m, prefix) => `${prefix}${REDACTED}`,
  },
  {
    // 环境变量赋值：FOO=bar cmd、export FOO=bar、env FOO=bar、set FOO=bar（值一律不保存）
    name: 'env-assignment',
    pattern: /(^|[\s;&|(]|\bexport\s+|\benv\s+|\bset\s+)([A-Z_][A-Z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|)]*)/g,
    replace: (m, prefix, name, value) => (value === REDACTED ? m : `${prefix}${name}=${REDACTED}`),
  },
  {
    // 中文键名：密码：xxx、令牌=xxx
    name: 'chinese-key-value',
    pattern: /(密码|口令|令牌|密钥|秘钥|私钥|凭证|凭据)(\s*[:：=]\s*)([^\s,，;；'"]+)/g,
    replace: (m, key, sep, value) => (value.includes('[REDACTED') ? m : `${key}${sep}${REDACTED}`),
  },
  {
    // PowerShell：$env:FOO = "bar"
    name: 'powershell-env',
    pattern: /(\$env:[A-Za-z_][A-Za-z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|[^\s;|]+)/g,
    replace: (_m, prefix) => `${prefix}${REDACTED}`,
  },
  {
    // password=xxx、"token": "xxx"、api_key: xxx、?access_token=xxx
    name: 'sensitive-key-value',
    pattern: new RegExp(
      String.raw`(["']?)\b(${SENSITIVE_KEY})\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&'"}\])]+)`,
      'gi',
    ),
    replace: (m, q, key, sep, value) => {
      if (value.includes('[REDACTED')) return m;
      const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
      return `${q}${key}${q}${sep}${quote}${REDACTED}${quote}`;
    },
  },
];

export interface RedactOptions {
  extraPatterns?: string[];
}

const extraCache = new Map<string, RegExp | null>();

function compileExtra(pattern: string): RegExp | null {
  if (!extraCache.has(pattern)) {
    try {
      extraCache.set(pattern, new RegExp(pattern, 'g'));
    } catch {
      extraCache.set(pattern, null);
    }
  }
  return extraCache.get(pattern) ?? null;
}

export function redact(text: string, options: RedactOptions = {}): string {
  if (!text) return text;
  let out = text;
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, rule.replace as (substring: string, ...args: string[]) => string);
  }
  for (const pattern of options.extraPatterns ?? []) {
    const re = compileExtra(pattern);
    if (re) {
      re.lastIndex = 0;
      out = out.replace(re, REDACTED);
    }
  }
  return out;
}

/** 去掉 git remote URL 中的凭据：https://token@github.com/a/b.git -> https://github.com/a/b.git */
export function sanitizeRemoteUrl(url: string): string {
  return url.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, '$1');
}
