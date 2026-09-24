import { redact } from './redact.js';

export type CommandCategory = 'test' | 'build' | 'lint' | 'install' | 'git' | 'run' | 'other';

export const CATEGORY_LABELS: Record<CommandCategory, string> = {
  test: '测试',
  build: '构建',
  lint: '检查/格式化',
  install: '依赖安装',
  git: 'Git',
  run: '运行',
  other: '其他',
};

export interface SanitizeOptions {
  maxLength: number;
  extraRedactPatterns?: string[];
}

/**
 * 把 Claude 执行的命令转换为可安全存储的摘要：
 * 1. 去掉 heredoc 正文（常用于写入源代码）；
 * 2. 去掉 python -c / node -e 等内联脚本；
 * 3. 敏感信息脱敏；
 * 4. 合并为单行并截断。
 */
export function sanitizeCommand(command: string, options: SanitizeOptions): string {
  let out = command.replace(/\r\n/g, '\n');
  out = out.replace(
    /<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_-]*)\1([^\n]*)\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g,
    (_m, _q, tag: string, rest: string) => `<<${tag}${rest} [heredoc 内容已省略]`,
  );
  out = out.replace(
    /\b(python[0-9.]*|py|node|nodejs|deno|bun|ruby|perl|php|Rscript|osascript)(\s+(?:-[A-Za-z]+\s+)*?)(-c|-e|-p|-r|--eval|--print|--command)\s+("(?:[^"\\]|\\[\s\S])*"|'[^']*'|\$'(?:[^'\\]|\\[\s\S])*')/g,
    (_m, bin: string, mid: string, flag: string) => `${bin}${mid}${flag} [内联脚本已省略]`,
  );
  out = redact(out, { extraPatterns: options.extraRedactPatterns });
  out = out.replace(/\\\n\s*/g, ' ').replace(/\s*\n\s*/g, ' ; ').replace(/[ \t]+/g, ' ').trim();
  if (out.length > options.maxLength) out = out.slice(0, options.maxLength - 1).trimEnd() + '…';
  return out;
}

/** 拆分复合命令（&&、||、;、|），返回每段去掉前导环境变量赋值后的文本。 */
export function splitCommandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\n/)
    .map((s) =>
      s
        .trim()
        .replace(/^\(+/, '')
        .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '')
        .replace(/^(?:sudo|time|nohup|command|exec)\s+/, '')
        .trim(),
    )
    .filter((s) => s.length > 0);
}

/** 所有子命令都属于忽略列表时，整条命令视为琐碎命令，不写入 commands 表。 */
export function isIgnoredCommand(command: string, ignore: string[]): boolean {
  const segments = splitCommandSegments(command);
  if (segments.length === 0) return true;
  const rules = ignore.map((r) => r.trim().split(/\s+/).filter(Boolean)).filter((r) => r.length > 0);
  return segments.every((segment) => {
    const tokens = segment.split(/\s+/);
    // 去掉可执行文件路径前缀：/usr/bin/ls -> ls
    tokens[0] = tokens[0]!.replace(/^.*[/\\]/, '');
    return rules.some((rule) => rule.every((part, i) => tokens[i] === part));
  });
}

const CATEGORY_PATTERNS: [CommandCategory, RegExp][] = [
  [
    'test',
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:vitest|jest|mocha|ava|pytest|tox|nox|phpunit|rspec|playwright\s+test|cypress\s+run|ctest)\b|\bgo\s+test\b|\bcargo\s+(?:test|nextest)\b|\bdotnet\s+test\b|\bmake\s+(?:test|check)\b|\bmvnw?\b.*\b(?:test|verify)\b|\bgradlew?\b.*\btest\b|\bpython[0-9.]*\s+-m\s+(?:pytest|unittest)\b|\bdeno\s+test\b|\bnpx\s+(?:vitest|jest|mocha|playwright)\b/,
  ],
  [
    'lint',
    /\b(?:eslint|prettier|biome|oxlint|stylelint|ruff|flake8|pylint|mypy|pyright|black|isort|golangci-lint|gofmt|rubocop|shellcheck|clippy)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:lint|format|fmt|typecheck|type-check|check)\b|\bcargo\s+(?:fmt|clippy)\b|\bgo\s+vet\b|\btsc\b[^|;&]*--noEmit\b/,
  ],
  [
    'build',
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|compile|bundle|pack)\b|\btsc\b|\bvite\s+build\b|\bwebpack\b|\besbuild\b|\brollup\b|\bnext\s+build\b|\bgo\s+build\b|\bcargo\s+build\b|\bdotnet\s+build\b|\bmvnw?\b.*\b(?:package|install|compile)\b|\bgradlew?\b.*\b(?:build|assemble)\b|\bcmake\b|\bmake\b|\bdocker\s+build\b|\bswift\s+build\b/,
  ],
  [
    'install',
    /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|ci|remove|uninstall|update|upgrade)\b|^\s*(?:yarn|pnpm)\s*$|\bpip[0-9.]*\s+install\b|\buv\s+(?:add|sync|pip|lock)\b|\bpoetry\s+(?:add|install|lock)\b|\bcargo\s+(?:add|install|update)\b|\bgo\s+(?:get|mod)\b|\bgem\s+install\b|\bbundle\s+install\b|\bcomposer\s+(?:install|require|update)\b|\bapt(?:-get)?\s+install\b|\bbrew\s+install\b|\bdotnet\s+(?:add|restore)\b/,
  ],
  ['git', /(?:^|[\s;&|(])git\s+[a-z]/],
  [
    'run',
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)\b|\b(?:node|nodejs|deno|bun|python[0-9.]*|ruby|php|java)\b|\bgo\s+run\b|\bcargo\s+run\b|\bdotnet\s+run\b|\bdocker(?:-compose)?\s+(?:run|up|compose|exec)\b|\bnpx\b/,
  ],
];

export function classifyCommand(command: string): CommandCategory {
  // 引号内的内容（提交信息、echo 文本等）不参与分类
  const bare = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(bare)) return category;
  }
  return 'other';
}

/**
 * 从 PostToolUseFailure 的 error 字段解析退出码。
 * 官方文档：Bash/PowerShell 命令执行后退出时，error 首行为 "Exit code N"。
 */
export function parseExitCode(error: unknown): number | null {
  const text =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : '';
  const match = /^\s*Exit code:?\s*(-?\d+)/i.exec(text);
  return match ? Number(match[1]) : null;
}
