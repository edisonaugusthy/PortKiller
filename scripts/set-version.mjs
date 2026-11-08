// Sets the app version everywhere it is stored: node scripts/set-version.mjs 1.2.3
// The Windows release runner checks out with CRLF line endings, so the patterns allow \r.
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2] ?? '';
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: node scripts/set-version.mjs 1.2.3');
  process.exit(1);
}
const edit = (file, change) => writeFileSync(file, change(readFileSync(file, 'utf8')));
const json = (file, change) => edit(file, text => `${JSON.stringify(change(JSON.parse(text)), null, 2)}\n`);

json('package.json', pkg => ({ ...pkg, version }));
json('package-lock.json', lock => ({ ...lock, version, packages: { ...lock.packages, '': { ...lock.packages[''], version } } }));
json('src-tauri/tauri.conf.json', config => ({ ...config, version }));
edit('src-tauri/Cargo.toml', text => text.replace(/^version = "[^"]*"/m, `version = "${version}"`));
edit('src-tauri/Cargo.lock', text => text.replace(/(name = "portkiller"\r?\nversion = ")[^"]+/, `$1${version}`));
console.log(`Version set to ${version}`);
