/**
 * 开发时长计算。
 *
 * 会话的墙钟时长（ended_at - started_at）会把"开着终端去吃饭"也算进去，
 * 因此"开发时长"采用活跃时长：同一会话内相邻两个事件（提示词、工具调用、回复结束等）
 * 间隔不超过 idleMinutes 时，这段时间计为活跃；超过则视为空闲，不计入。
 * 多个会话并行时取时间并集，避免重复计算。
 */

export interface ActivityPoint {
  sessionId: number;
  projectId: number | null;
  /** 毫秒时间戳 */
  t: number;
}

export interface Interval {
  start: number;
  end: number;
  sessionId: number;
  projectId: number | null;
}

/** points 需按 sessionId、t 排序。 */
export function buildIntervals(points: ActivityPoint[], idleMs: number): Interval[] {
  const intervals: Interval[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    if (prev.sessionId !== cur.sessionId) continue;
    const gap = cur.t - prev.t;
    if (gap > 0 && gap <= idleMs) {
      intervals.push({ start: prev.t, end: cur.t, sessionId: cur.sessionId, projectId: cur.projectId ?? prev.projectId });
    }
  }
  return intervals;
}

export function clipIntervals(intervals: Interval[], start: number, end: number): Interval[] {
  const out: Interval[] = [];
  for (const iv of intervals) {
    const s = Math.max(iv.start, start);
    const e = Math.min(iv.end, end);
    if (e > s) out.push({ ...iv, start: s, end: e });
  }
  return out;
}

/** 区间并集的总长度（毫秒）。 */
export function unionLength(intervals: { start: number; end: number }[]): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = sorted[0]!.start;
  let curEnd = sorted[0]!.end;
  for (let i = 1; i < sorted.length; i++) {
    const iv = sorted[i]!;
    if (iv.start <= curEnd) {
      if (iv.end > curEnd) curEnd = iv.end;
    } else {
      total += curEnd - curStart;
      curStart = iv.start;
      curEnd = iv.end;
    }
  }
  return total + (curEnd - curStart);
}

export interface ActivitySummary {
  totalSeconds: number;
  bySession: Map<number, number>;
  byProject: Map<number, number>;
}

export function summarizeIntervals(intervals: Interval[]): ActivitySummary {
  const bySessionMs = new Map<number, number>();
  const byProjectIntervals = new Map<number, Interval[]>();
  for (const iv of intervals) {
    bySessionMs.set(iv.sessionId, (bySessionMs.get(iv.sessionId) ?? 0) + (iv.end - iv.start));
    if (iv.projectId !== null) {
      const list = byProjectIntervals.get(iv.projectId) ?? [];
      list.push(iv);
      byProjectIntervals.set(iv.projectId, list);
    }
  }
  const bySession = new Map<number, number>();
  for (const [id, ms] of bySessionMs) bySession.set(id, Math.round(ms / 1000));
  const byProject = new Map<number, number>();
  for (const [id, list] of byProjectIntervals) byProject.set(id, Math.round(unionLength(list) / 1000));
  return { totalSeconds: Math.round(unionLength(intervals) / 1000), bySession, byProject };
}
