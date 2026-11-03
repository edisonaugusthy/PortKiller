import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Also support a Rust toolchain installed without rustup's command shims.
const env = { ...process.env };
if (spawnSync('cargo', ['--version'], { env, stdio: 'ignore' }).error) {
  const toolchains = join(homedir(), '.rustup', 'toolchains');
  if (existsSync(toolchains)) {
    const stable = readdirSync(toolchains).find(name => name.startsWith('stable-'));
    if (stable) env.PATH = join(toolchains, stable, 'bin') + delimiter + (env.PATH ?? '');
  }
}
const cli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url));
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { env, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
