import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'usage: node scripts/verify-git-release.mjs <release-tag> <main-ref> <allowed-signers-file>';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function git(args, label) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`${label} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout.trim();
}

const [suppliedTag, mainRef, suppliedSignersPath] = process.argv.slice(2);
assert(process.argv.length === 5 && suppliedTag && mainRef && suppliedSignersPath, usage);
assert(/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(suppliedTag), 'release tag must be an exact vMAJOR.MINOR.PATCH tag');
assert(
  /^refs\/(?:heads|remotes\/origin)\/main$/u.test(mainRef),
  'main ref must be refs/heads/main or refs/remotes/origin/main',
);

const packageDocument = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
assert(suppliedTag === `v${packageDocument.version}`, `release tag ${suppliedTag} must exactly equal v${packageDocument.version}`);

const signersPath = resolve(root, suppliedSignersPath);
const relativeSignersPath = relative(root, signersPath);
assert(
  relativeSignersPath !== '' && !relativeSignersPath.startsWith('..') && !relativeSignersPath.startsWith('/'),
  'allowed signers file must be inside the package repository',
);
const allowedSigners = (await readFile(signersPath, 'utf8'))
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));
assert(allowedSigners.length > 0, 'allowed signers file must contain at least one trusted release signer');
for (const signer of allowedSigners) {
  assert(
    /^\S+\s+(?:cert-authority\s+)?(?:namespaces="git"\s+)?(?:ssh-ed25519|sk-ssh-ed25519@openssh\.com|ecdsa-sha2-nistp256|sk-ecdsa-sha2-nistp256@openssh\.com|ssh-rsa)\s+\S+(?:\s+.*)?$/u.test(signer),
    'allowed signers file contains an invalid signer entry',
  );
}

const tagRef = `refs/tags/${suppliedTag}`;
assert(git(['cat-file', '-t', tagRef], 'release tag lookup') === 'tag', `${suppliedTag} must be an annotated tag`);

const tagObject = git(['cat-file', '-p', tagRef], 'release tag inspection');
const targetMatch = tagObject.match(/^object ([0-9a-f]{40,64})$/mu);
assert(targetMatch, `${suppliedTag} has no direct target object`);
const targetObject = targetMatch[1];
assert(git(['cat-file', '-t', targetObject], 'release tag target inspection') === 'commit', `${suppliedTag} must point directly to a commit`);

const verification = spawnSync(
  'git',
  [
    '-c',
    'gpg.format=ssh',
    '-c',
    `gpg.ssh.allowedSignersFile=${signersPath}`,
    'verify-tag',
    tagRef,
  ],
  { cwd: root, encoding: 'utf8' },
);
assert(
  verification.status === 0,
  `${suppliedTag} must have a valid signature from .github/release-signers${verification.stderr.trim() ? `: ${verification.stderr.trim()}` : ''}`,
);

const tagCommit = git(['rev-parse', '--verify', `${tagRef}^{commit}`], 'release tag commit lookup');
const mainCommit = git(['rev-parse', '--verify', `${mainRef}^{commit}`], 'main commit lookup');
const headCommit = git(['rev-parse', '--verify', 'HEAD^{commit}'], 'checked-out commit lookup');
assert(tagCommit === mainCommit, `${suppliedTag} commit ${tagCommit} must exactly equal ${mainRef} commit ${mainCommit}`);
assert(headCommit === tagCommit, `checked-out HEAD ${headCommit} must exactly equal ${suppliedTag} commit ${tagCommit}`);

console.log(`verified signed annotated ${suppliedTag} at exact main commit ${tagCommit}`);
