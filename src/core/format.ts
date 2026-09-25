import { getLang } from '../i18n.js';

/** 3725 -> "1小时2分钟"；45 -> "<1分钟"；0 -> "0分钟"（英文：1h 2m / <1m / 0m） */
export function formatDuration(seconds: number, compact = false): string {
  const s = Math.max(0, Math.round(seconds));
  if (getLang() === 'en') {
    if (s < 60) return s === 0 ? '0m' : '<1m';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`;
  }
  if (s === 0) return compact ? '0分' : '0分钟';
  if (s < 60) return compact ? '<1分' : '<1分钟';
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const m = compact ? '分' : '分钟';
  if (hours === 0) return `${minutes}${m}`;
  if (minutes === 0) return `${hours}小时`;
  return `${hours}小时${minutes}${m}`;
}

export function toHours(seconds: number): number {
  return Math.round((seconds / 3600) * 10) / 10;
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

export function percent(part: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((part / total) * 100)}%`;
}

/** 1234 -> "1.2K"；3456789 -> "3.5M" */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

/** 估算费用（美元） */
export function formatCost(usd: number | null): string {
  if (usd === null) return '-';
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}
