import {
  defaultConfig,
  getConfigValue,
  parseConfigValue,
  saveConfig,
  setConfigValue,
  ConfigError,
} from '../../config.js';
import { getPaths, tildify } from '../../paths.js';
import { CliError, loadConfigOrThrow, printJson } from '../context.js';
import { c } from '../format.js';

export async function runConfigList(): Promise<void> {
  const paths = getPaths();
  const config = loadConfigOrThrow(paths.configFile);
  console.error(c.gray(`# ${tildify(paths.configFile)}`));
  printJson(config);
}

export async function runConfigGet(key: string): Promise<void> {
  const config = loadConfigOrThrow();
  try {
    const value = getConfigValue(config, key);
    if (typeof value === 'string') console.log(value);
    else printJson(value);
  } catch (err) {
    if (err instanceof ConfigError) throw new CliError(err.message);
    throw err;
  }
}

export async function runConfigSet(key: string, rawValue: string): Promise<void> {
  const paths = getPaths();
  const config = loadConfigOrThrow(paths.configFile);
  try {
    const next = setConfigValue(config, key, parseConfigValue(rawValue));
    saveConfig(next, paths.configFile);
    const value = getConfigValue(next, key);
    console.log(`${c.green('✔')} ${key} = ${value === undefined ? c.gray('(未设置)') : JSON.stringify(value)}`);
  } catch (err) {
    if (err instanceof ConfigError) throw new CliError(err.message);
    throw err;
  }
}

export async function runConfigUnset(key: string): Promise<void> {
  const paths = getPaths();
  const config = loadConfigOrThrow(paths.configFile);
  try {
    const next = setConfigValue(config, key, null);
    saveConfig(next, paths.configFile);
    console.log(`${c.green('✔')} 已清除 ${key}`);
  } catch (err) {
    if (err instanceof ConfigError) throw new CliError(err.message);
    throw err;
  }
}

export async function runConfigReset(): Promise<void> {
  const paths = getPaths();
  saveConfig(defaultConfig(), paths.configFile);
  console.log(`${c.green('✔')} 已恢复默认配置：${tildify(paths.configFile)}`);
}

export async function runConfigPath(): Promise<void> {
  console.log(getPaths().configFile);
}
