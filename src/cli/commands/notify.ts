import { saveConfig, type DevTrackConfig } from '../../config.js';
import { L } from '../../i18n.js';
import { getPaths } from '../../paths.js';
import {
  describeTarget,
  NOTIFY_TYPES,
  sendAll,
  type NotifyDeps,
  type NotifyMessage,
  type NotifyTarget,
  type NotifyType,
} from '../../notify/webhook.js';
import { CliError, loadConfigOrThrow } from '../context.js';
import { c } from '../format.js';

/**
 * 推送到所有已配置的目标并打印结果。没有配置目标时报错；任一目标失败时返回 false。
 */
export async function pushMessage(config: DevTrackConfig, message: NotifyMessage, deps: NotifyDeps = {}): Promise<boolean> {
  const targets = config.notify.targets;
  if (targets.length === 0) {
    throw new CliError(L('还没有配置推送目标，先运行 devtrack notify add <类型> <Webhook 地址>', 'No notify targets configured; run devtrack notify add <type> <webhook-url> first'));
  }
  const results = await sendAll(targets, message, deps);
  for (const r of results) {
    if (r.ok) console.error(`${c.green('✔')} ${L('已推送到', 'Sent to')} ${r.target}`);
    else console.error(`${c.red('✖')} ${r.target}${L('：', ': ')}${r.error}`);
  }
  return results.every((r) => r.ok);
}

export interface NotifyAddOptions {
  name?: string;
  urlEnv?: string;
  secret?: string;
  secretEnv?: string;
}

export async function runNotifyAdd(type: string, url: string | undefined, options: NotifyAddOptions): Promise<void> {
  if (!(NOTIFY_TYPES as readonly string[]).includes(type)) {
    throw new CliError(`类型只支持 ${NOTIFY_TYPES.join(' / ')}：${type}`);
  }
  if (!url && !options.urlEnv) throw new CliError('请提供 Webhook 地址，或用 --url-env 指定读取地址的环境变量');
  if ((options.secret || options.secretEnv) && type !== 'dingtalk') {
    throw new CliError('--secret / --secret-env 目前只用于钉钉"加签"');
  }
  const paths = getPaths();
  const config = loadConfigOrThrow(paths.configFile);
  const target: NotifyTarget = { type: type as NotifyType };
  if (url) target.url = url;
  if (options.urlEnv) target.urlEnv = options.urlEnv;
  if (options.secret) target.secret = options.secret;
  if (options.secretEnv) target.secretEnv = options.secretEnv;
  if (options.name) {
    if (config.notify.targets.some((t) => t.name === options.name)) throw new CliError(`已经有名为 ${options.name} 的推送目标`);
    target.name = options.name;
  }
  config.notify.targets.push(target);
  try {
    saveConfig(config, paths.configFile);
  } catch (err) {
    // zod 校验失败（例如地址不是 http/https）
    throw new CliError(`推送目标无效：${(err as Error).message.split('\n')[0]}`);
  }
  console.log(`${c.green('✔')} 已添加 ${describeTarget(target, config.notify.targets.length - 1)}`);
  console.log(c.gray('  运行 devtrack notify test 发送一条测试消息。'));
  if (url) console.log(c.gray('  Webhook 地址已保存在配置文件中；也可以改用 --url-env 从环境变量读取。'));
}

export async function runNotifyList(): Promise<void> {
  const config = loadConfigOrThrow(getPaths().configFile);
  const targets = config.notify.targets;
  if (targets.length === 0) {
    console.log(c.gray('还没有配置推送目标。示例：devtrack notify add feishu https://open.feishu.cn/open-apis/bot/v2/hook/xxx'));
    return;
  }
  for (const [i, t] of targets.entries()) {
    console.log(`  ${describeTarget(t, i)}${t.secret || t.secretEnv ? c.gray('（加签）') : ''}`);
  }
  console.log(c.gray(`\n  自动推送周报：${config.notify.autoWeekly ? '开启' : '关闭'}（notify.autoWeekly）`));
}

export async function runNotifyRemove(which: string): Promise<void> {
  const paths = getPaths();
  const config = loadConfigOrThrow(paths.configFile);
  const targets = config.notify.targets;
  let index = targets.findIndex((t) => t.name === which);
  if (index < 0 && /^#?\d+$/.test(which)) index = Number(which.replace('#', '')) - 1;
  if (index < 0 || index >= targets.length) throw new CliError(`没有找到推送目标：${which}（运行 devtrack notify list 查看）`);
  const [removed] = targets.splice(index, 1);
  try {
    saveConfig(config, paths.configFile);
  } catch (err) {
    throw new CliError(`保存配置失败：${(err as Error).message.split('\n')[0]}`);
  }
  console.log(`${c.green('✔')} 已删除 ${describeTarget(removed!)}`);
}

export async function runNotifyTest(): Promise<number | void> {
  const config = loadConfigOrThrow(getPaths().configFile);
  const ok = await pushMessage(config, {
    kind: 'test',
    title: L('DevTrack 测试消息', 'DevTrack test message'),
    text: L('推送配置正常。之后可以用 devtrack standup --send、devtrack report --send 推送站会摘要和周报。', 'Notifications are working. Use devtrack standup --send and devtrack report --send to share your standup and reports.'),
  });
  return ok ? undefined : 1;
}
