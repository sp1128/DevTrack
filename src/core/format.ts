/** 3725 -> "1小时2分钟"；45 -> "<1分钟"；0 -> "0分钟" */
export function formatDuration(seconds: number, compact = false): string {
  const s = Math.max(0, Math.round(seconds));
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
