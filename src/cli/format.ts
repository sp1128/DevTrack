/** 终端输出工具：颜色（遵循 NO_COLOR / FORCE_COLOR）、中文宽度感知的对齐与表格。 */

function colorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(process.stdout.isTTY);
}

function wrap(open: number, close: number) {
  return (text: string | number) => (colorEnabled() ? `\u001b[${open}m${text}\u001b[${close}m` : String(text));
}

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

function isWide(cp: number): boolean {
  return (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  );
}

/** 终端显示宽度：中日韩字符算 2 列。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of stripAnsi(text)) {
    const cp = ch.codePointAt(0)!;
    if (cp < 32 || (cp >= 0x7f && cp < 0xa0) || (cp >= 0x300 && cp <= 0x36f) || cp === 0x200b) continue;
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

/** 按显示宽度截断（不处理含颜色的文本）。 */
export function truncate(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = isWide(ch.codePointAt(0)!) ? 2 : 1;
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

export function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

export function padStart(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - displayWidth(text))) + text;
}

export interface TableOptions {
  /** 右对齐的列下标 */
  alignRight?: number[];
  indent?: number;
  /** 各列最大宽度（超出截断） */
  maxWidths?: (number | undefined)[];
}

export function table(headers: string[], rows: string[][], options: TableOptions = {}): string {
  const indent = ' '.repeat(options.indent ?? 2);
  const cells = rows.map((r) =>
    r.map((cellText, i) => {
      const max = options.maxWidths?.[i];
      return max && displayWidth(stripAnsi(cellText)) > max ? truncate(stripAnsi(cellText), max) : cellText;
    }),
  );
  const widths = headers.map((h, i) => Math.max(displayWidth(h), ...cells.map((r) => displayWidth(r[i] ?? ''))));
  const right = new Set(options.alignRight ?? []);
  const fmt = (r: string[], isHeader = false) =>
    indent +
    r
      .map((cellText, i) => {
        const text = isHeader ? c.dim(cellText) : cellText;
        if (i === r.length - 1 && !right.has(i)) return text;
        return right.has(i) ? padStart(text, widths[i]!) : padEnd(text, widths[i]!);
      })
      .join('  ');
  return [fmt(headers, true), ...cells.map((r) => fmt(r))].join('\n');
}

/** 键值对列表：标签按显示宽度对齐。 */
export function keyValues(pairs: [string, string][], indent = 2): string {
  const width = Math.max(...pairs.map(([k]) => displayWidth(k)));
  return pairs.map(([k, v]) => `${' '.repeat(indent)}${padEnd(c.gray(k), width)}  ${v}`).join('\n');
}

export function heading(text: string): string {
  return `\n${c.bold(c.cyan(text))}`;
}

export function bar(value: number, max: number, width = 20): string {
  if (max <= 0 || value <= 0) return '';
  const n = Math.max(1, Math.round((value / max) * width));
  return c.green('█'.repeat(n));
}
