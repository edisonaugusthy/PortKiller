// The Mac half of a release, on this Mac: PortKiller for Apple silicon and Intel, signed with the
// Developer ID and notarized, in place of the ad-hoc signed build the Release workflow puts in its
// draft. Tauri signs, notarizes and staples the app and then packs the update archive itself;
// nothing is packed by hand, and everything is checked the way an installed app reads it.
//
//   node scripts/release-mac.mjs            builds and checks; changes nothing on GitHub
//   node scripts/release-mac.mjs --upload   also replaces the Mac files and feed entries in the draft
//
// Afterwards: node scripts/publish-release.mjs
//
// Needs both Rust targets (rustup target add aarch64-apple-darwin x86_64-apple-darwin), the Developer ID
// certificate in the keychain, and outside Git: ~/.tauri/apple-release/notary-identifiers.json with its
// AuthKey_<keyId>.p8, and ~/.tauri/portkiller-updater.key. Nothing from them is printed.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORMS, TEAM, downloader, verifyFeed, verifyOnMac } from './verify-updater.mjs';
import { MACOS_SOURCE, WINDOWS_SOURCE, verifyReleaseSource } from './release-source.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = 'edisonaugusthy/PortKiller';
const upload = process.argv.includes('--upload');
const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const version = conf.version, tag = `v${version}`;
const vault = join(homedir(), '.tauri/apple-release');

const fail = message => { console.error(message); process.exit(1); };
/** Runs a step; `quiet` keeps its output, which may name credentials, off the screen. */
function run(command, args, { quiet = false, env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' });
  if (result.error || result.status !== 0) fail(`Release step failed: ${command} ${quiet ? args[0] : args.join(' ')}`);
  return result.stdout ?? '';
}

if (process.platform !== 'darwin') fail('Build the Mac release on a Mac.');
const scratch = mkdtempSync(join(tmpdir(), 'portkiller-release-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));

function assertDraftSource() {
  const draft = JSON.parse(run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'isDraft'], { quiet: true }));
  if (!draft.isDraft) fail(`${tag} is already published. Published files are never replaced; release a new version.`);
  const windowsSource = run('gh', ['release', 'download', tag, '--repo', repo, '--pattern', WINDOWS_SOURCE, '--output', '-'], { quiet: true });
  const macSource = run('git', ['rev-parse', 'HEAD'], { quiet: true });
  try {
    const commit = verifyReleaseSource(windowsSource, macSource);
    if (run('git', ['status', '--porcelain'], { quiet: true }).trim()) fail(`Build the Mac release from a clean checkout of ${commit}.`);
    return commit;
  } catch (error) {
    fail(error.message);
  }
}

const sourceCommit = upload ? assertDraftSource() : null;
const release = JSON.parse(run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'isDraft'], { quiet: true }));
const ids = JSON.parse(readFileSync(join(vault, 'notary-identifiers.json'), 'utf8'));
if (ids.teamId !== TEAM) fail('The notarization credentials are for another team.');
const identity = `Developer ID Application: Edison Augusthy (${TEAM})`;
const notary = ['--key', join(vault, `AuthKey_${ids.keyId}.p8`), '--key-id', ids.keyId, '--issuer', ids.issuerId];

run(process.execPath, ['scripts/tauri.mjs', 'build', '--target', 'universal-apple-darwin', '--bundles', 'app,dmg', '--config', 'src-tauri/tauri.release.conf.json'], {
  env: {
    ...process.env,
    APPLE_SIGNING_IDENTITY: identity,
    APPLE_API_KEY: ids.keyId,
    APPLE_API_ISSUER: ids.issuerId,
    APPLE_API_KEY_PATH: notary[1],
    TAURI_SIGNING_PRIVATE_KEY: join(homedir(), '.tauri/portkiller-updater.key'),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '',
  },
});

const bundle = join(root, 'src-tauri/target/universal-apple-darwin/release/bundle');
const out = join(root, 'release', version);
mkdirSync(out, { recursive: true });
// The names the Release workflow gives these files, so uploading replaces its ad-hoc build.
const archive = join(out, 'PortKiller_universal.app.tar.gz');
const dmg = join(out, `PortKiller_${version}_universal.dmg`);
copyFileSync(join(bundle, 'macos/PortKiller.app.tar.gz'), archive);
copyFileSync(join(bundle, 'macos/PortKiller.app.tar.gz.sig'), `${archive}.sig`);
copyFileSync(join(bundle, `dmg/PortKiller_${version}_universal.dmg`), dmg);

// Tauri notarized the app; the DMG people download needs its own ticket.
run('codesign', ['--force', '--sign', identity, '--timestamp', dmg]);
const submission = JSON.parse(run('xcrun', ['notarytool', 'submit', dmg, ...notary, '--wait', '--output-format', 'json'], { quiet: true }));
if (submission.status !== 'Accepted') fail(`Apple did not accept the DMG (${submission.status}, submission ${submission.id}).`);
run('xcrun', ['stapler', 'staple', dmg]);
copyFileSync(dmg, join(out, 'PortKiller-macOS.dmg'));

// The feed for this release: the workflow's entries for Windows, and this build for every Mac.
try {
  run('gh', ['release', 'download', tag, '--repo', repo, '--pattern', 'latest.json', '--dir', scratch], { quiet: true });
  const manifest = JSON.parse(readFileSync(join(scratch, 'latest.json'), 'utf8'));
  if (manifest.version !== version) fail(`The draft offers ${manifest.version}, but the code is at ${version}.`);
  const mac = { signature: readFileSync(`${archive}.sig`, 'utf8').trim(), url: `https://github.com/${repo}/releases/download/${tag}/${basename(archive)}` };
  for (const platform of ['darwin-aarch64', 'darwin-x86_64', 'darwin-aarch64-app', 'darwin-x86_64-app']) manifest.platforms[platform] = mac;
  writeFileSync(join(out, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // The Windows installer is fetched from the release with gh, since a draft's files are not public.
  const published = downloader(scratch);
  const fileFor = async url => {
    if (url === mac.url) return archive;
    if (!release.isDraft) return published(url);
    run('gh', ['release', 'download', tag, '--repo', repo, '--pattern', basename(url), '--dir', scratch, '--clobber'], { quiet: true });
    return join(scratch, basename(url));
  };
  const checked = await verifyFeed({ manifest, publicKey: conf.plugins.updater.pubkey, appName: conf.productName, platforms: PLATFORMS, notarized: true, fileFor });
  verifyOnMac({ archive, dmg, appName: conf.productName });
  console.log(`PortKiller ${version} for Mac is built, notarized and installs:\n  ${checked.join('\n  ')}\n  ${out}`);
} catch (error) {
  fail(`Release check failed: ${error.message}`);
}

if (!upload) {
  console.log('Nothing was uploaded. Run again with --upload to put this build into the draft.');
} else {
  if (assertDraftSource() !== sourceCommit) fail('The draft source changed during the Mac build.');
  const sourceFile = join(out, MACOS_SOURCE);
  writeFileSync(sourceFile, `${sourceCommit}\n`);
  run('gh', ['release', 'upload', tag, archive, `${archive}.sig`, dmg, join(out, 'PortKiller-macOS.dmg'), join(out, 'latest.json'), sourceFile, '--repo', repo, '--clobber']);
  run(process.execPath, ['scripts/publish-release.mjs', '--check']);
  console.log('The draft now holds the notarized Mac build. Publish it with: node scripts/publish-release.mjs');
}
