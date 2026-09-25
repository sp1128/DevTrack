// 按函数子路径导入：整包导入 date-fns 会让每次启动慢约 800ms
import { addDays } from 'date-fns/addDays';
import { addMonths } from 'date-fns/addMonths';
import { addWeeks } from 'date-fns/addWeeks';
import { addYears } from 'date-fns/addYears';
import { format } from 'date-fns/format';
import { getISOWeek } from 'date-fns/getISOWeek';
import { getISOWeekYear } from 'date-fns/getISOWeekYear';
import { isValid } from 'date-fns/isValid';
import { parseISO } from 'date-fns/parseISO';
import { setISOWeek } from 'date-fns/setISOWeek';
import { startOfDay } from 'date-fns/startOfDay';
import { startOfISOWeek } from 'date-fns/startOfISOWeek';
import { startOfMonth } from 'date-fns/startOfMonth';
import { subDays } from 'date-fns/subDays';
import { subMonths } from 'date-fns/subMonths';
import { subWeeks } from 'date-fns/subWeeks';
import { subYears } from 'date-fns/subYears';
import { subHours } from 'date-fns/subHours';
import { getLang } from '../i18n.js';

export interface DateRange {
  /** 包含 */
  start: Date;
  /** 不包含 */
  end: Date;
  label: string;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function weekdayLabel(d: Date): string {
  return (getLang() === 'en' ? WEEKDAYS_EN : WEEKDAYS)[d.getDay()]!;
}

export function formatDate(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

export function formatDateTime(d: Date): string {
  return format(d, 'yyyy-MM-dd HH:mm');
}

export function formatTime(d: Date): string {
  return format(d, 'HH:mm');
}

export function todayRange(now: Date, offsetDays = 0): DateRange {
  const start = addDays(startOfDay(now), offsetDays);
  const weekday = weekdayLabel(start);
  return { start, end: addDays(start, 1), label: getLang() === 'en' ? `${formatDate(start)} (${weekday})` : `${formatDate(start)}（${weekday}）` };
}

/** ISO 周（周一为一周的开始）。 */
export function weekRange(now: Date, offsetWeeks = 0): DateRange {
  const start = addWeeks(startOfISOWeek(now), offsetWeeks);
  return { start, end: addWeeks(start, 1), label: isoWeekLabel(start) };
}

export function monthRange(now: Date, offsetMonths = 0): DateRange {
  const start = addMonths(startOfMonth(now), offsetMonths);
  return { start, end: addMonths(start, 1), label: format(start, 'yyyy-MM') };
}

/** 2026-09-24 -> 2026-W39 */
export function isoWeekLabel(d: Date): string {
  return `${getISOWeekYear(d)}-W${String(getISOWeek(d)).padStart(2, '0')}`;
}

/** 解析 2026-W39 / 2026W39 为对应的周区间。 */
export function parseIsoWeek(label: string): DateRange | null {
  const m = /^(\d{4})-?W(\d{1,2})$/i.exec(label.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  // 1 月 4 日总是在 ISO 第 1 周
  const start = startOfISOWeek(setISOWeek(new Date(year, 0, 4), week));
  if (getISOWeekYear(start) !== year) return null;
  return { start, end: addWeeks(start, 1), label: isoWeekLabel(start) };
}

/** 解析 YYYY-MM 为对应的月区间。 */
export function parseMonth(label: string): DateRange | null {
  const m = /^(\d{4})-(\d{1,2})$/.exec(label.trim());
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  const start = new Date(Number(m[1]), month - 1, 1);
  return { start, end: addMonths(start, 1), label: format(start, 'yyyy-MM') };
}

/** 解析 YYYY-MM-DD 为本地时区的一天。 */
export function parseDay(label: string): DateRange | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(label.trim())) return null;
  const d = parseISO(label.trim());
  if (!isValid(d)) return null;
  return todayRange(d);
}

/**
 * 解析相对时长或日期，返回截止时间点：
 *   30d / 12h / 2w / 6m / 1y  -> now 减去对应时长
 *   2026-01-01                 -> 该日期本地零点
 */
export function parseCutoff(spec: string, now: Date): Date | null {
  const s = spec.trim().toLowerCase();
  const m = /^(\d+)\s*([hdwmy])$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    switch (m[2]) {
      case 'h':
        return subHours(now, n);
      case 'd':
        return subDays(now, n);
      case 'w':
        return subWeeks(now, n);
      case 'm':
        return subMonths(now, n);
      case 'y':
        return subYears(now, n);
    }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = parseISO(s);
    return isValid(d) ? startOfDay(d) : null;
  }
  return null;
}

/** 区间内的每一天（本地时区）。 */
export function eachDay(range: DateRange): Date[] {
  const days: Date[] = [];
  for (let d = startOfDay(range.start); d < range.end; d = addDays(d, 1)) days.push(d);
  return days;
}

export function startOfDayLocal(d: Date): Date {
  return startOfDay(d);
}

export function iso(d: Date): string {
  return d.toISOString();
}

export { addDays, addYears };
