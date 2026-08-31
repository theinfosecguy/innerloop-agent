import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function version(path) {
  const document = JSON.parse(await readFile(resolve(root, path), 'utf8'));
  assert(typeof document.version === 'string' && document.version.length > 0, `${path} version is missing`);
  return document.version;
}

const suppliedTag = process.argv[2];
assert(process.argv.length === 3 && suppliedTag, 'usage: node scripts/verify-release-tag.mjs <release-tag>');

const versions = new Map(await Promise.all([
  'package.json',
  'server.json',
  'listing.json',
  'release-manifest.json',
].map(async (path) => [path, await version(path)])));
const packageVersion = versions.get('package.json');
for (const [path, value] of versions) {
  assert(value === packageVersion, `${path} version ${value} differs from package.json version ${packageVersion}`);
}

const expectedTag = `v${packageVersion}`;
assert(suppliedTag === expectedTag, `release tag ${suppliedTag} must exactly equal ${expectedTag}`);
console.log(`verified ${expectedTag} across ${versions.size} release documents`);
