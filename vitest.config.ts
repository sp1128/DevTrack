import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // 固定时区，保证日期区间相关断言在任何机器上结果一致
    env: { TZ: 'UTC', NO_COLOR: '1' },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
