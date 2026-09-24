import { chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
if (process.platform !== 'win32' && existsSync(cli)) chmodSync(cli, 0o755);
