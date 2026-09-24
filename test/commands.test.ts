import { describe, expect, it } from 'vitest';
import { DEFAULT_IGNORED_COMMANDS } from '../src/config.js';
import { classifyCommand, isIgnoredCommand, parseExitCode, sanitizeCommand } from '../src/core/commands.js';

const opts = { maxLength: 300 };

describe('sanitizeCommand', () => {
  it('省略 heredoc 正文（避免保存源代码）', () => {
    const cmd = "cat > src/a.ts <<'EOF'\nexport const secret = 42;\nconsole.log(secret);\nEOF\nnpm test";
    const out = sanitizeCommand(cmd, opts);
    expect(out).not.toContain('secret');
    expect(out).toContain('<<EOF');
    expect(out).toContain('heredoc 内容已省略');
    expect(out).toContain('npm test');
  });

  it('省略内联脚本', () => {
    expect(sanitizeCommand(`python3 -c "import os; print(os.environ)"`, opts)).toBe('python3 -c [内联脚本已省略]');
    expect(sanitizeCommand(`node -e 'console.log(1)' && npm test`, opts)).toBe('node -e [内联脚本已省略] && npm test');
  });

  it('合并多行并截断', () => {
    expect(sanitizeCommand('npm install \\\n  --save-dev vitest', opts)).toBe('npm install --save-dev vitest');
    expect(sanitizeCommand('cd app\nnpm test', opts)).toBe('cd app ; npm test');
    const long = sanitizeCommand('echo ' + 'a'.repeat(500), { maxLength: 50 });
    expect(long.length).toBe(50);
    expect(long.endsWith('…')).toBe(true);
  });

  it('同时进行敏感信息脱敏', () => {
    expect(sanitizeCommand('TOKEN=abc curl -H "Authorization: Bearer xyz" x', opts)).toBe(
      'TOKEN=[REDACTED] curl -H "Authorization: [REDACTED]" x',
    );
  });
});

describe('isIgnoredCommand', () => {
  const ignore = DEFAULT_IGNORED_COMMANDS;
  it('忽略只读的琐碎命令', () => {
    for (const cmd of ['ls -la', 'pwd', 'cat a.txt | grep foo | wc -l', 'git status', 'git diff --stat', '/bin/ls']) {
      expect(isIgnoredCommand(cmd, ignore), cmd).toBe(true);
    }
  });
  it('只要有一段是重要命令就保留', () => {
    for (const cmd of ['cd app && npm test', 'git commit -m x', 'ls && make', 'FOO=[REDACTED] npm run build']) {
      expect(isIgnoredCommand(cmd, ignore), cmd).toBe(false);
    }
  });
});

describe('classifyCommand', () => {
  it.each([
    ['npm test', 'test'],
    ['pnpm run test -- --watch=false', 'test'],
    ['pytest -x tests/', 'test'],
    ['go test ./...', 'test'],
    ['cargo test', 'test'],
    ['npm run build', 'build'],
    ['tsc -p tsconfig.json', 'build'],
    ['tsc --noEmit', 'lint'],
    ['npx eslint src', 'lint'],
    ['npm install zod', 'install'],
    ['pip install -r requirements.txt', 'install'],
    ['git commit -m "make it faster"', 'git'],
    ['git push origin main', 'git'],
    ['npm run dev', 'run'],
    ['python3 scripts/seed.py', 'run'],
    ['terraform plan', 'other'],
  ])('%s -> %s', (cmd, category) => {
    expect(classifyCommand(cmd)).toBe(category);
  });
});

describe('parseExitCode', () => {
  it('解析官方文档中的 "Exit code N" 首行', () => {
    expect(parseExitCode("Exit code 1\nError: Cannot find module 'express'")).toBe(1);
    expect(parseExitCode('Exit code 127')).toBe(127);
    expect(parseExitCode({ message: 'Exit code 2' })).toBe(2);
    expect(parseExitCode('Command timed out after 2m 0s')).toBeNull();
    expect(parseExitCode(undefined)).toBeNull();
  });
});
