// Publishes the draft release, once everything in it is proven to install. Never publish a draft
// with `gh release edit` by hand: this check is what stands between a bad package and every user.
//
//   node scripts/publish-release.mjs            checks the draft of the version in the code, then publishes it
//   node scripts/publish-release.mjs --check    checks it (draft or published) and stops
//
// The release's files are downloaded and its latest.json is checked with verify-updater.mjs: every
// platform is there, each download is signed for this version by the key built into the app, and the
// Mac archive unpacks the way the updater unpacks it, into a notarized app of this version for Apple
// silicon and Intel. On a Mac, the app and the DMG are also checked with codesign, stapler and
// Gatekeeper. After publishing, the feed installed apps read is downloaded and checked again.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { PLATFORMS, verifyFeed, verifyLiveFeed, verifyOnMac } from './verify-updater.mjs';
import { MACOS_SOURCE, WINDOWS_SOURCE, verifyReleaseSource } from './release-source.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = 'edisonaugusthy/PortKiller';
const checkOnly = process.argv.includes('--check');
const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const version = conf.version, tag = `v${version}`;
// The fixed names the website and the README link to.
const downloads = ['PortKiller-macOS.dmg', 'PortKiller-Windows-Setup.exe'];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.slice(0, 3).join(' ')} failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  return result.stdout ?? '';
}

const scratch = mkdtempSync(join(tmpdir(), 'portkiller-publish-'));
try {
  const release = JSON.parse(run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'isDraft,assets']));
  run('gh', ['release', 'download', tag, '--repo', repo, '--dir', scratch]);
  const names = release.assets.map(asset => asset.name);
  const required = [...downloads, 'latest.json'];
  if (release.isDraft || names.includes(WINDOWS_SOURCE) || names.includes(MACOS_SOURCE)) required.push(WINDOWS_SOURCE, MACOS_SOURCE);
  for (const name of required) if (!names.includes(name)) throw new Error(`The release has no ${name}`);
  if (required.includes(WINDOWS_SOURCE)) {
    verifyReleaseSource(readFileSync(join(scratch, WINDOWS_SOURCE), 'utf8'), readFileSync(join(scratch, MACOS_SOURCE), 'utf8'));
  }
  const manifest = JSON.parse(readFileSync(join(scratch, 'latest.json'), 'utf8'));
  if (manifest.version !== version) throw new Error(`latest.json offers ${manifest.version}, but this is the release of ${version}`);
  const prefix = `https://github.com/${repo}/releases/download/${tag}/`;
  const fileFor = async url => {
    const file = join(scratch, basename(url));
    if (!url.startsWith(prefix) || !existsSync(file)) throw new Error(`latest.json points at ${url}, which is not a file of this release`);
    return file;
  };
  const checked = await verifyFeed({ manifest, publicKey: conf.plugins.updater.pubkey, appName: conf.productName, platforms: PLATFORMS, notarized: true, fileFor });
  if (process.platform === 'darwin') {
    verifyOnMac({ archive: await fileFor(manifest.platforms['darwin-aarch64'].url), dmg: join(scratch, 'PortKiller-macOS.dmg'), appName: conf.productName });
    checked.push('codesign, notarization ticket and Gatekeeper: Mac app and DMG');
  }
  console.log(`${tag} installs on every platform:\n  ${checked.join('\n  ')}`);

  if (release.isDraft && !checkOnly) {
    run('gh', ['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest']);
    console.log(`Published ${tag}.`);
  }
  if (!release.isDraft || !checkOnly) {
    // GitHub takes a moment to serve a new release as the latest.
    for (let attempt = 1; ; attempt++) {
      try {
        const live = await verifyLiveFeed();
        if (!isDeepStrictEqual(live.manifest, manifest)) throw new Error(`installed apps are offered ${live.manifest.version}, not this release's latest.json`);
        console.log(`Installed apps are now offered ${version}, and every download installs.`);
        break;
      } catch (error) {
        if (attempt === 6) throw new Error(`${tag} is published, but the live feed check failed: ${error.message}. To withdraw it: gh release edit ${tag} --repo ${repo} --draft=true`);
        await new Promise(resolve => setTimeout(resolve, 10_000));
      }
    }
  }
} catch (error) {
  console.error(`Release check failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
