// Checks an update the way an installed app reads it (tauri-plugin-updater), so a package that
// cannot be installed is caught before anyone is offered it.
//
// A valid signature is not enough. On macOS the updater drops the first path component of every
// archive entry and unpacks the rest over the app. An archive made with plain macOS `tar` also
// holds `._` metadata entries, the first of them next to the app folder rather than in it, and
// the updater fails on that entry on every Mac, while `tar -x` unpacks the same file without
// complaint. PortKiller 0.3.0 shipped such an archive.
//
//   node scripts/verify-updater.mjs          checks what installed apps are offered right now
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

/** Every Mac and PC PortKiller runs on. A release without one of them never reaches those users. */
export const PLATFORMS = ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64'];
/** The Apple developer team that signs the Mac app. */
export const TEAM = 'DGB59A73J6';

/**
 * The updater's signature check: the file against the public key built into the app, then the
 * version the file was signed for against the version the feed announces. Returns the trusted comment.
 */
export function verifyUpdater(file, encodedSignature, encodedPublicKey, version) {
  const publicLines = Buffer.from(encodedPublicKey.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
  const lines = Buffer.from(encodedSignature.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
  if (lines.length !== 4 || !lines[2].startsWith('trusted comment: ')) throw new Error('Invalid updater signature format');
  const pub = Buffer.from(publicLines[1], 'base64');
  const sig = Buffer.from(lines[1], 'base64');
  if (pub.length !== 42 || sig.length !== 74 || !pub.subarray(2, 10).equals(sig.subarray(2, 10))) throw new Error('Updater key mismatch');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub.subarray(10)]), format: 'der', type: 'spki' });
  const data = readFileSync(file);
  const algorithm = sig.subarray(0, 2).toString();
  if (!['Ed', 'ED'].includes(algorithm)) throw new Error('Unsupported updater signature algorithm');
  const message = algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  if (!verify(null, message, key, sig.subarray(10))) throw new Error('Updater archive signature failed');
  const comment = lines[2].slice('trusted comment: '.length);
  if (!verify(null, Buffer.concat([sig.subarray(10), Buffer.from(comment)]), key, Buffer.from(lines[3], 'base64'))) throw new Error('Updater trusted comment signature failed');
  const signedFor = comment.split('\t').find(field => field.startsWith('version:'))?.slice('version:'.length);
  if (version && signedFor && signedFor.replace(/^v/, '') !== version.replace(/^v/, '')) throw new Error(`Signed for version ${signedFor}, but offered as ${version}`);
  return comment;
}

/** The entries of a .tar.gz as the updater's reader lists them: long names resolved, in archive order. */
export function archiveEntries(file) {
  const tar = gunzipSync(readFileSync(file));
  const text = bytes => { const end = bytes.indexOf(0); return bytes.subarray(0, end < 0 ? bytes.length : end).toString('utf8'); };
  const entries = [];
  let longPath = null, longLink = null, pax = {};
  for (let at = 0; ;) {
    const header = tar.subarray(at, at + 512);
    if (header.length < 512) throw new Error('Update archive ends without its closing blocks');
    if (header.every(byte => byte === 0)) break;
    const sum = header.reduce((total, byte, i) => total + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (sum !== parseInt(text(header.subarray(148, 156)).trim(), 8)) throw new Error('Update archive has a damaged entry header');
    const size = header[124] & 0x80 ? Number(header.readBigUInt64BE(128)) : parseInt(text(header.subarray(124, 136)).trim() || '0', 8);
    const data = tar.subarray(at + 512, at + 512 + size);
    if (data.length < size) throw new Error('Update archive is cut short');
    at += 512 + Math.ceil(size / 512) * 512;
    const type = header[156] ? String.fromCharCode(header[156]) : '0';
    if (type === 'L') { longPath = text(data); continue; }
    if (type === 'K') { longLink = text(data); continue; }
    if (type === 'x' || type === 'g') {
      // Records are "<length> <key>=<value>\n"; only a path or link target changes what is unpacked.
      const records = {};
      for (let i = 0; i < data.length;) {
        const space = data.indexOf(32, i), length = Number(data.subarray(i, space).toString());
        if (space < 0 || !(length > 0)) throw new Error('Update archive has a damaged extended header');
        const record = data.subarray(space + 1, i + length - 1).toString('utf8'), equals = record.indexOf('=');
        records[record.slice(0, equals)] = record.slice(equals + 1);
        i += length;
      }
      if (type === 'x') pax = records;
      continue;
    }
    const ustar = header.subarray(257, 265).toString('latin1') === 'ustar\u000000';
    const prefix = ustar ? text(header.subarray(345, 500)) : '';
    const name = text(header.subarray(0, 100));
    entries.push({
      path: longPath ?? pax.path ?? (prefix ? `${prefix}/${name}` : name),
      link: longLink ?? pax.linkpath ?? text(header.subarray(157, 257)),
      type,
      mode: parseInt(text(header.subarray(100, 108)).trim() || '0', 8),
      data,
    });
    longPath = longLink = null; pax = {};
  }
  return entries;
}

/**
 * Checks a macOS update archive entry by entry with the updater's rules, and reads the app inside:
 * its version, and the processors its executable runs on. `notarized` also requires Apple's
 * notarization ticket in the app, which only a notarized and stapled app carries.
 */
export function verifyArchive(file, appName, { notarized = false } = {}) {
  const root = `${appName}.app`;
  const entries = archiveEntries(file);
  const files = new Map();
  for (const entry of entries) {
    const parts = entry.path.split('/').filter((part, i, all) => part !== '' || (i === 0 && all.length > 1));
    const where = `Update archive entry "${entry.path}"`;
    if (parts.some(part => part.startsWith('._'))) throw new Error(`${where} is macOS file metadata, which the updater cannot unpack. Let Tauri build the archive; never pack it with tar by hand.`);
    if (parts[0] !== root) throw new Error(`${where} is outside ${root}. The updater drops the first folder of every entry, so the archive must hold exactly ${root}/…`);
    if (parts.some(part => part === '' || part === '.' || part === '..')) throw new Error(`${where} is not a plain path inside ${root}`);
    if (!['0', '5', '2'].includes(entry.type)) throw new Error(`${where} is neither a file, a folder nor a symbolic link`);
    if (parts.length === 1 && entry.type !== '5') throw new Error(`${where} must be the app folder`);
    if (entry.type === '2') {
      // A link may only point inside the app.
      const target = entry.link.startsWith('/') ? [] : parts.slice(0, -1);
      for (const part of entry.link.split('/')) {
        if (part === '..') target.pop(); else if (part !== '.' && part !== '') target.push(part);
        if (target[0] !== root) throw new Error(`${where} links outside ${root}`);
      }
    }
    files.set(parts.slice(1).join('/'), entry);
  }
  const plist = files.get('Contents/Info.plist')?.data.toString('utf8');
  if (!plist) throw new Error(`Update archive has no ${root}/Contents/Info.plist`);
  const value = key => plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1];
  const version = value('CFBundleShortVersionString'), executable = value('CFBundleExecutable');
  if (!version || !executable) throw new Error('The app in the update archive has no version or executable name');
  const binary = files.get(`Contents/MacOS/${executable}`);
  if (!binary || binary.type !== '0' || !(binary.mode & 0o100)) throw new Error(`The app in the update archive has no executable Contents/MacOS/${executable}`);
  if (notarized && files.get('Contents/CodeResources')?.type !== '0') throw new Error('The app in the update archive is not notarized: it has no stapled ticket (Contents/CodeResources)');
  return { version, executable, architectures: architectures(binary.data) };
}

/** The processors a Mach-O executable runs on, named as update feeds name them. */
function architectures(binary) {
  const name = type => ({ 0x01000007: 'x86_64', 0x0100000c: 'aarch64' })[type] ?? `cpu-${type.toString(16)}`;
  if (binary.length < 8) return [];
  const magic = binary.readUInt32BE(0);
  if (magic === 0xcffaedfe) return [name(binary.readUInt32LE(4))];
  if (magic !== 0xcafebabe && magic !== 0xcafebabf) return [];
  const step = magic === 0xcafebabe ? 20 : 32;
  return Array.from({ length: binary.readUInt32BE(4) }, (_, i) => name(binary.readUInt32BE(8 + i * step)));
}

/** Tauri parses pub_date before it looks for an update on the current platform. */
function validReleaseDate(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2})[\x00-\x7f]([01]\d|2[0-3]):([0-5]\d):([0-5]\d|60)(?:\.\d+)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.exec(value);
  if (!match || match[0] !== value) return false;
  const [, day, hours, minutes, seconds, offset] = match;
  const calendar = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || !calendar.toISOString().startsWith(day)) return false;
  if (seconds !== '60') return true;
  // Tauri's time parser accepts a leap second only at the end of a UTC month.
  const utc = new Date(`${day}T${hours}:${minutes}:59${offset.toUpperCase()}`);
  return utc.getUTCHours() === 23 && utc.getUTCMinutes() === 59
    && new Date(utc.getTime() + 1000).getUTCDate() === 1;
}

function validateManifest(manifest, requiredPlatforms) {
  const { version, notes, pub_date, platforms, url, signature } = manifest ?? {};
  const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (typeof version !== 'string' || stableVersion?.[0] !== version
    || stableVersion.slice(1).some(part => BigInt(part) > 0xffffffffffffffffn)) {
    throw new Error('Feed version must be a stable semantic version');
  }
  if (Object.hasOwn(manifest, 'name')) throw new Error('Feed cannot include both version and its name alias');
  if (notes != null && typeof notes !== 'string') throw new Error('Feed notes must be a string');
  if (pub_date != null && !validReleaseDate(pub_date)) throw new Error('Feed pub_date must be an RFC 3339 timestamp');
  if (url != null && (typeof url !== 'string' || !URL.canParse(url))) throw new Error('Feed url must be an absolute URL');
  if (signature != null && typeof signature !== 'string') throw new Error('Feed signature must be a string');
  if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms)) throw new Error('Feed platforms must be an object');
  for (const platform of requiredPlatforms) {
    if (!Object.hasOwn(platforms, platform)) throw new Error(`Feed has no ${platform} entry: those installs would never see ${version}`);
  }
  for (const [platform, entry] of Object.entries(platforms)) {
    if (typeof entry?.url !== 'string' || !entry.url.startsWith('https://') || !URL.canParse(entry.url)
      || typeof entry.signature !== 'string' || !entry.signature.trim()) {
      throw new Error(`Feed entry ${platform} needs an https url and a signature`);
    }
  }
  return platforms;
}

/**
 * Checks everything a feed (latest.json) offers: that each of `platforms` is there, and for every
 * entry its signature, the version it was signed for, and for a Mac the archive and the app in it.
 * `fileFor(url)` returns that download as a local file. Returns one line per platform checked.
 */
export async function verifyFeed({ manifest, publicKey, appName, platforms, notarized = false, fileFor }) {
  const offered = validateManifest(manifest, platforms);
  const checked = [];
  for (const [platform, { url, signature }] of Object.entries(offered)) {
    const file = await fileFor(url);
    verifyUpdater(file, signature, publicKey, manifest.version);
    const [os, arch] = platform.split('-');
    if (os === 'darwin') {
      const app = verifyArchive(file, appName, { notarized });
      if (app.version !== manifest.version) throw new Error(`${platform}: the feed offers ${manifest.version}, but the app in the archive is ${app.version}`);
      if (!app.architectures.includes(arch)) throw new Error(`${platform}: the app in the archive runs on ${app.architectures.join(', ') || 'no known processor'} only`);
    } else if (os === 'windows' && readFileSync(file).subarray(0, 2).toString('latin1') !== 'MZ') {
      throw new Error(`${platform}: ${basename(new URL(url).pathname)} is not a Windows installer`);
    }
    checked.push(`${platform}  ${basename(new URL(url).pathname)}`);
  }
  return checked;
}

/**
 * On a Mac: unpacks an archive that passed `verifyArchive` and checks the app the updater would
 * install, and the DMG, with codesign, the notarization ticket and Gatekeeper.
 */
export function verifyOnMac({ archive, dmg, appName }) {
  const run = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error(`${command} ${args.slice(0, 2).join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
    return result;
  };
  const scratch = mkdtempSync(join(tmpdir(), 'updater-app-'));
  try {
    run('tar', ['-xzf', archive, '-C', scratch]);
    const app = join(scratch, `${appName}.app`);
    run('codesign', ['--verify', '--deep', '--strict', app]);
    const signature = run('codesign', ['-dvv', app]).stderr;
    if (!signature.includes('Authority=Developer ID Application:') || !signature.includes(`TeamIdentifier=${TEAM}`) || !signature.includes('runtime')) throw new Error('The Mac app is not signed with the Developer ID and hardened runtime');
    run('xcrun', ['stapler', 'validate', app]);
    run('spctl', ['--assess', '--type', 'execute', app]);
    run('xcrun', ['stapler', 'validate', dmg]);
    run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', dmg]);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Downloads `url` into `directory`, once per URL, following redirects like the updater does. */
export function downloader(directory) {
  const done = new Map();
  return async url => {
    if (!done.has(url)) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Download failed with status ${response.status}: ${url}`);
      const file = join(directory, `${done.size}-${basename(new URL(url).pathname)}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
      done.set(url, file);
    }
    return done.get(url);
  };
}

/** Checks the feed installed apps read, with every download in it. Returns the version and the checks. */
export async function verifyLiveFeed({ notarized = true } = {}) {
  const conf = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src-tauri/tauri.conf.json'), 'utf8'));
  const feed = conf.plugins.updater.endpoints[0];
  const response = await fetch(feed);
  if (!response.ok) throw new Error(`Feed returned status ${response.status}: ${feed}`);
  const manifest = await response.json();
  const directory = mkdtempSync(join(tmpdir(), 'portkiller-feed-'));
  try {
    const checked = await verifyFeed({ manifest, publicKey: conf.plugins.updater.pubkey, appName: conf.productName, platforms: PLATFORMS, notarized, fileFor: downloader(directory) });
    return { manifest, checked };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { manifest, checked } = await verifyLiveFeed();
    console.log(`Installed apps are offered ${manifest.version}, and every download installs:\n  ${checked.join('\n  ')}`);
  } catch (error) {
    console.error(`Update feed check failed: ${error.message}`);
    process.exit(1);
  }
}
