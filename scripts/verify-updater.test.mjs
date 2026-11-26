// node --test scripts/verify-updater.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { verifyArchive, verifyFeed, verifyUpdater } from './verify-updater.mjs';
import { verifyReleaseSource } from './release-source.mjs';

const dir = mkdtempSync(join(tmpdir(), 'updater-verification-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
const write = bytes => { const file = join(dir, `file-${files++}`); writeFileSync(file, bytes); return file; };

/** A .tar.gz of [path, content | null for a folder | { link }] entries. */
function archive(entries) {
  const blocks = entries.map(([path, content]) => {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(typeof content === 'string' ? content : '');
    const header = Buffer.alloc(512);
    const link = content === null || Buffer.isBuffer(content) || typeof content === 'string' ? null : content.link;
    const type = content === null ? '5' : link ? '2' : '0';
    header.write(path, 0);
    header.write(type === '0' && !path.includes('/MacOS/') ? '0000644\0' : '0000755\0', 100);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('        ', 148);
    header.write(type, 156);
    if (link) header.write(link, 157);
    header.write('ustar\u000000', 257, 'latin1');
    header.write(`${header.reduce((total, byte) => total + byte, 0).toString(8).padStart(6, '0')}\0 `, 148);
    return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
  });
  return write(gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])));
}

const plist = version => `<plist><dict><key>CFBundleExecutable</key><string>demo</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`;
const arm = Buffer.from('cffaedfe0c000001', 'hex');
const universal = Buffer.concat([Buffer.from('cafebabe00000002', 'hex'), Buffer.from('01000007', 'hex'), Buffer.alloc(16), Buffer.from('0100000c', 'hex'), Buffer.alloc(16)]);
/** What Tauri's bundler packs for Demo.app, notarized. */
const app = (version = '1.2.0', binary = universal) => [
  ['Demo.app', null],
  ['Demo.app/Contents', null],
  ['Demo.app/Contents/Info.plist', plist(version)],
  ['Demo.app/Contents/MacOS', null],
  ['Demo.app/Contents/MacOS/demo', binary],
  ['Demo.app/Contents/CodeResources', 'ticket'],
];

/** An update key and its signer, in the format the Tauri CLI writes. */
function signer() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const id = randomBytes(8);
  const publicBytes = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const encode = (id, bytes) => Buffer.from(`untrusted comment: test\n${Buffer.concat([Buffer.from('Ed'), id, bytes]).toString('base64')}`).toString('base64');
  return {
    publicKey: encode(id, publicBytes),
    otherKey: encode(randomBytes(8), publicBytes),
    text(content, comment) {
      const signature = sign(null, createHash('blake2b512').update(content).digest(), privateKey);
      const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
      return `untrusted comment: test\n${Buffer.concat([Buffer.from('ED'), id, signature]).toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}`;
    },
    sign(file, version) {
      return Buffer.from(this.text(readFileSync(file), `timestamp:123\tfile:update\tversion:${version}`)).toString('base64');
    },
  };
}

test('the signature covers the content, the trusted comment and the version, and rejects another key', () => {
  const key = signer();
  const content = Buffer.from('release artifact');
  const file = write(content);
  const text = key.text(content, 'timestamp:123\tfile:update\tversion:1.2.0');
  const encoded = Buffer.from(text).toString('base64');
  assert.match(verifyUpdater(file, encoded, key.publicKey, '1.2.0'), /version:1\.2\.0/);
  assert.throws(() => verifyUpdater(file, encoded, key.publicKey, '1.3.0'), /Signed for version 1\.2\.0, but offered as 1\.3\.0/);
  assert.throws(() => verifyUpdater(file, Buffer.from(text.replace('timestamp:123', 'timestamp:124')).toString('base64'), key.publicKey), /trusted comment signature failed/);
  assert.throws(() => verifyUpdater(file, encoded, key.otherKey), /key mismatch/);
  writeFileSync(file, 'changed artifact');
  assert.throws(() => verifyUpdater(file, encoded, key.publicKey), /archive signature failed/);
});

test('an archive as Tauri builds it passes, and reports the app inside', () => {
  assert.deepEqual(verifyArchive(archive(app()), 'Demo', { notarized: true }), { version: '1.2.0', executable: 'demo', architectures: ['x86_64', 'aarch64'] });
  assert.deepEqual(verifyArchive(archive([...app(), ['Demo.app/Contents/Frameworks/Current', { link: 'A/../B' }]]), 'Demo').architectures, ['x86_64', 'aarch64']);
});

test('macOS metadata entries are refused: the updater fails on them on every Mac', () => {
  assert.throws(() => verifyArchive(archive([['._Demo.app', 'metadata'], ...app()]), 'Demo'), /"\._Demo\.app" is macOS file metadata/);
  assert.throws(() => verifyArchive(archive([...app(), ['Demo.app/Contents/._Info.plist', 'metadata']]), 'Demo'), /macOS file metadata/);
});

test('an archive made with plain macOS tar is refused', { skip: process.platform !== 'darwin' }, () => {
  const folder = join(dir, 'packed'), bundle = join(folder, 'Demo.app');
  mkdirSync(join(bundle, 'Contents/MacOS'), { recursive: true });
  writeFileSync(join(bundle, 'Contents/Info.plist'), plist('1.2.0'));
  writeFileSync(join(bundle, 'Contents/MacOS/demo'), universal, { mode: 0o755 });
  // Notarized apps always carry extended attributes; this is what makes tar add the metadata entries.
  assert.equal(spawnSync('xattr', ['-w', 'com.example.note', 'stapled', bundle]).status, 0);
  const packed = join(dir, 'packed.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', packed, '-C', folder, 'Demo.app']).status, 0);
  assert.equal(spawnSync('tar', ['-tzf', packed], { encoding: 'utf8' }).stdout.includes('._'), false, 'tar hides the entries it added');
  assert.throws(() => verifyArchive(packed, 'Demo'), /macOS file metadata/);
});

test('anything the updater would unpack in the wrong place is refused', () => {
  const moved = prefix => app().map(([path, content]) => [`${prefix}${path}`, content]);
  assert.throws(() => verifyArchive(archive(moved('./')), 'Demo'), /outside Demo\.app/);
  assert.throws(() => verifyArchive(archive(moved('build/')), 'Demo'), /outside Demo\.app/);
  assert.throws(() => verifyArchive(archive(app()), 'Other'), /outside Other\.app/);
  assert.throws(() => verifyArchive(archive([['Demo.app', 'a file']]), 'Demo'), /must be the app folder/);
  assert.throws(() => verifyArchive(archive([...app(), ['Demo.app/Contents/../../escape', 'x']]), 'Demo'), /not a plain path/);
  assert.throws(() => verifyArchive(archive([...app(), ['Demo.app/Contents/link', { link: '/Applications' }]]), 'Demo'), /links outside/);
  assert.throws(() => verifyArchive(archive([...app(), ['Demo.app/Contents/link', { link: '../../elsewhere' }]]), 'Demo'), /links outside/);
});

test('an incomplete or unnotarized app is refused', () => {
  const without = path => app().filter(([entry]) => entry !== path);
  assert.throws(() => verifyArchive(archive(without('Demo.app/Contents/Info.plist')), 'Demo'), /no Demo\.app\/Contents\/Info\.plist/);
  assert.throws(() => verifyArchive(archive(without('Demo.app/Contents/MacOS/demo')), 'Demo'), /no executable/);
  assert.throws(() => verifyArchive(archive(without('Demo.app/Contents/CodeResources')), 'Demo', { notarized: true }), /not notarized/);
  assert.doesNotThrow(() => verifyArchive(archive(without('Demo.app/Contents/CodeResources')), 'Demo'));
  const whole = gunzipSync(readFileSync(archive(app())));
  assert.throws(() => verifyArchive(write(gzipSync(whole.subarray(0, 1536))), 'Demo'), /closing blocks|cut short/);
});

test('manifest metadata that Tauri would reject fails before any download', async () => {
  const options = {
    platforms: ['darwin-aarch64'],
    fileFor: async () => assert.fail('invalid manifest should fail before downloading'),
  };
  const entry = { url: 'https://example.com/mac', signature: 'signed' };
  const manifest = { version: '1.2.0', platforms: { 'darwin-aarch64': entry } };
  for (const pub_date of ['2026-11-26', '2026-02-29T00:00:00Z', '2026-11-26T12:00:00', '2026-11-26T12:00:00+24:00', '2026-11-26T12:00:60Z', 42]) {
    await assert.rejects(verifyFeed({ ...options, manifest: { ...manifest, pub_date } }), /pub_date/);
  }
  for (const version of [1, '01.2.0', '1.2.0\n', '18446744073709551616.2.0']) {
    await assert.rejects(verifyFeed({ ...options, manifest: { ...manifest, version } }), /semantic version/);
  }
  await assert.rejects(verifyFeed({ ...options, manifest: { ...manifest, notes: [] } }), /notes/);
  await assert.rejects(verifyFeed({ ...options, manifest: { ...manifest, platforms: [] } }), /platforms/);
  for (const invalidEntry of [null, { ...entry, signature: 42 }, { ...entry, url: 'https://' }]) {
    await assert.rejects(verifyFeed({ ...options, manifest: { ...manifest, platforms: { ...manifest.platforms, another: invalidEntry } } }), /another needs an https url and a signature/);
  }
});

test('a feed is checked for every platform, version and processor it offers', async () => {
  const key = signer();
  const installer = write(Buffer.from('MZ installer'));
  const feed = (mac, version = '1.2.0', drop) => {
    const files = { 'https://example.com/mac': mac, 'https://example.com/windows': installer };
    const entry = url => ({ url, signature: key.sign(files[url], version) });
    const platforms = { 'darwin-aarch64': entry('https://example.com/mac'), 'darwin-x86_64': entry('https://example.com/mac'), 'windows-x86_64': entry('https://example.com/windows') };
    delete platforms[drop];
    return { manifest: { version, platforms }, publicKey: key.publicKey, appName: 'Demo', platforms: ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64'], notarized: true, fileFor: async url => files[url] };
  };
  const healthy = feed(archive(app()));
  for (const pub_date of [undefined, null, '2026-11-26T06:30:10.123456Z', '2024-02-29T00:00:00-03:30', '2016-12-31T23:59:60Z']) {
    assert.equal((await verifyFeed({ ...healthy, manifest: { ...healthy.manifest, pub_date } })).length, 3);
  }
  await assert.rejects(verifyFeed(feed(archive(app()), '1.2.0', 'darwin-x86_64')), /no darwin-x86_64 entry/);
  await assert.rejects(verifyFeed(feed(archive(app('1.1.0')))), /offers 1\.2\.0, but the app in the archive is 1\.1\.0/);
  await assert.rejects(verifyFeed(feed(archive(app('1.2.0', arm)))), /darwin-x86_64: the app in the archive runs on aarch64 only/);
  await assert.rejects(verifyFeed(feed(archive([['._Demo.app', 'metadata'], ...app()]))), /macOS file metadata/);
  const resigned = feed(archive(app()));
  resigned.manifest.version = '1.3.0';
  await assert.rejects(verifyFeed(resigned), /Signed for version 1\.2\.0, but offered as 1\.3\.0/);
  const wrong = feed(archive(app()));
  wrong.fileFor = async () => installer;
  await assert.rejects(verifyFeed(wrong), /signature failed/);
});

test('Mac and Windows builds of the draft must come from the same complete commit', () => {
  const windows = 'a'.repeat(40);
  assert.equal(verifyReleaseSource(windows + '\r\n', windows + '\n'), windows);
  assert.throws(() => verifyReleaseSource(windows, 'b'.repeat(40)), /Windows build commit a+/);
  assert.throws(() => verifyReleaseSource('main', windows), /no valid Windows build commit/);
});
