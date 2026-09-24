import { describe, expect, it } from 'vitest';
import { buildIntervals, clipIntervals, summarizeIntervals, unionLength, type ActivityPoint } from '../src/stats/activity.js';

const MIN = 60_000;
const t0 = Date.parse('2026-09-24T09:00:00Z');

function pts(sessionId: number, projectId: number, minutes: number[]): ActivityPoint[] {
  return minutes.map((m) => ({ sessionId, projectId, t: t0 + m * MIN }));
}

describe('活跃时长', () => {
  it('间隔超过空闲阈值的时间不计入', () => {
    // 0→10→20 活跃 20 分钟；20→80 空闲 60 分钟；80→85 活跃 5 分钟
    const intervals = buildIntervals(pts(1, 1, [0, 10, 20, 80, 85]), 30 * MIN);
    expect(summarizeIntervals(intervals).totalSeconds).toBe(25 * 60);
  });

  it('并行会话取并集，不重复计算', () => {
    const points = [...pts(1, 1, [0, 10, 20]), ...pts(2, 2, [5, 15, 25])];
    const summary = summarizeIntervals(buildIntervals(points, 30 * MIN));
    expect(summary.totalSeconds).toBe(25 * 60); // 0~25
    expect(summary.bySession.get(1)).toBe(20 * 60);
    expect(summary.bySession.get(2)).toBe(20 * 60);
    expect(summary.byProject.get(1)).toBe(20 * 60);
    expect(summary.byProject.get(2)).toBe(20 * 60);
  });

  it('按时间范围裁剪（跨天会话只计算范围内部分）', () => {
    const intervals = buildIntervals(pts(1, 1, [0, 20, 40]), 30 * MIN);
    const clipped = clipIntervals(intervals, t0 + 10 * MIN, t0 + 30 * MIN);
    expect(summarizeIntervals(clipped).totalSeconds).toBe(20 * 60);
  });

  it('unionLength 处理嵌套与相邻区间', () => {
    expect(
      unionLength([
        { start: 0, end: 10 },
        { start: 2, end: 5 },
        { start: 10, end: 12 },
        { start: 20, end: 25 },
      ]),
    ).toBe(17);
    expect(unionLength([])).toBe(0);
  });
});
