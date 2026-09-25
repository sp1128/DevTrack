import type { DB } from '../db/database.js';
import { deleteMeta, getMeta } from '../db/purge.js';
import { tildify } from '../paths.js';
import { c } from './format.js';
import { L } from '../i18n.js';

/** 自动生成报告后留给下一次 today / week 显示的提示 */
export const AUTO_REPORT_NOTICE_KEY = 'auto_report_notice';

/** 取出并清除自动生成报告的提示（只显示一次）。 */
export function consumeAutoReportNotice(db: DB): string {
  const target = getMeta(db, AUTO_REPORT_NOTICE_KEY);
  if (!target) return '';
  deleteMeta(db, AUTO_REPORT_NOTICE_KEY);
  return c.gray(
    L(
      `\n已自动生成上周周报：${tildify(target)}（运行 devtrack report --last 可重新生成）\n`,
      `\nLast week's report was generated automatically: ${tildify(target)} (run devtrack report --last to regenerate)\n`,
    ),
  );
}
