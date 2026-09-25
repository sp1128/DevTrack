import { describe, expect, it } from 'vitest';
import { REDACTED, redact, sanitizeRemoteUrl } from '../src/core/redact.js';

describe('redact', () => {
  it('按文档示例脱敏 Authorization 头', () => {
    expect(redact('Authorization: Bearer xxx')).toBe('Authorization: [REDACTED]');
    expect(redact(`curl -H "Authorization: Bearer abc.def.ghi" https://x.io`)).toBe(
      'curl -H "Authorization: [REDACTED]" https://x.io',
    );
  });

  it('脱敏 Cookie / API Key 等请求头', () => {
    expect(redact(`curl -H 'Cookie: sid=abc; token=def' x`)).toBe(`curl -H 'Cookie: [REDACTED]' x`);
    expect(redact('X-Api-Key: 12345')).toBe('X-Api-Key: [REDACTED]');
  });

  it('脱敏常见令牌格式', () => {
    // 均为虚构的样例。运行时拼接前缀，避免源码中出现完整的令牌格式而被 GitHub 密钥扫描误报
    const samples = [
      ['sk-ant-', 'api03-abcdefghijklmnopqrstuvwxyz'],
      ['sk-proj-', 'ABCDEFGHIJKLMNOPQRST1234'],
      ['ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789'],
      ['github_pat_', '11ABCDEFG0123456789_abcdefghijklmnop'],
      ['glpat-', 'abcdefghijklmnopqrst'],
      ['xoxb-', '1234567890-abcdefghij'],
      ['AKIA', 'ABCDEFGHIJKLMNOP'],
      ['AIza', 'SyA1234567890abcdefghijklmnopqrstuv'],
      ['eyJhbGciOiJIUzI1NiJ9.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ].map(([prefix, rest]) => prefix! + rest!);
    for (const s of samples) {
      const out = redact(`echo ${s}`);
      expect(out, s).not.toContain(s);
      expect(out).toContain(REDACTED);
    }
  });

  it('脱敏命令行密码参数', () => {
    expect(redact('mycli --password hunter2 --user bob')).toBe('mycli --password [REDACTED] --user bob');
    expect(redact('mycli --token=abc123')).toBe('mycli --token=[REDACTED]');
    expect(redact('mycli --api-key "a b c"')).toBe('mycli --api-key [REDACTED]');
    expect(redact('curl -u admin:s3cret https://x')).toBe('curl -u admin:[REDACTED] https://x');
    expect(redact('mysql -u root -ps3cret db')).toBe('mysql -u root -p[REDACTED] db');
  });

  it('参数名必须是独立的参数，不误伤普通单词', () => {
    expect(redact('npm run test-auth token')).toBe('npm run test-auth token');
    expect(redact('git log --author=bob')).toBe('git log --author=bob');
    expect(redact('gpg --passphrase abc')).toBe('gpg --passphrase [REDACTED]');
  });

  it('脱敏中文键名', () => {
    expect(redact('数据库密码：abc123，端口 5432')).toBe('数据库密码：[REDACTED]，端口 5432');
    expect(redact('令牌=xyz')).toBe('令牌=[REDACTED]');
  });

  it('脱敏环境变量赋值（值一律不保存）', () => {
    expect(redact('API_KEY=abc npm test')).toBe('API_KEY=[REDACTED] npm test');
    expect(redact('export GITHUB_TOKEN=ghx123')).toBe('export GITHUB_TOKEN=[REDACTED]');
    expect(redact('NODE_ENV=production npm run build')).toBe('NODE_ENV=[REDACTED] npm run build');
    expect(redact('$env:OPENAI_KEY = "abc"')).toBe('$env:OPENAI_KEY = [REDACTED]');
    // 小写的普通参数不受影响
    expect(redact('git log --since=2026-01-01 --format=%H')).toBe('git log --since=2026-01-01 --format=%H');
  });

  it('脱敏 URL 中的凭据与敏感查询参数', () => {
    expect(redact('git clone https://user:pass@github.com/a/b.git')).toBe('git clone https://[REDACTED]@github.com/a/b.git');
    expect(redact('curl "https://api.x.io/v1?access_token=abc&x=1"')).toBe('curl "https://api.x.io/v1?access_token=[REDACTED]&x=1"');
  });

  it('脱敏 JSON / 配置中的敏感键', () => {
    expect(redact('{"password":"p@ss","user":"bob"}')).toBe('{"password":"[REDACTED]","user":"bob"}');
    expect(redact("client_secret: 'abc'")).toBe("client_secret: '[REDACTED]'");
  });

  it('脱敏 SSH 私钥', () => {
    const kind = 'OPENSSH PRIVATE ' + 'KEY';
    const key = `-----BEGIN ${kind}-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END ${kind}-----`;
    expect(redact(`echo "${key}" > id`)).toBe('echo "[REDACTED PRIVATE KEY]" > id');
  });

  it('多次脱敏结果不变（幂等）', () => {
    const input = 'Cookie: a=b; Authorization: Bearer abcdefghijk API_KEY=x --token y password=z';
    const once = redact(input);
    expect(redact(once)).toBe(once);
  });

  it('普通命令保持不变', () => {
    for (const cmd of ['npm test', 'git commit -m "fix: 修复登录"', 'pytest -k login -x', 'docker compose up -d']) {
      expect(redact(cmd)).toBe(cmd);
    }
  });

  it('支持自定义脱敏正则', () => {
    expect(redact('deploy --env prod-42', { extraPatterns: ['prod-\\d+'] })).toBe('deploy --env [REDACTED]');
    // 非法正则被忽略而不是抛错
    expect(redact('abc', { extraPatterns: ['('] })).toBe('abc');
  });

  it('去掉 git remote 中的凭据', () => {
    expect(sanitizeRemoteUrl('https://oauth2:tok@gitlab.com/g/p.git')).toBe('https://gitlab.com/g/p.git');
    expect(sanitizeRemoteUrl('git@github.com:a/b.git')).toBe('git@github.com:a/b.git');
  });
});
