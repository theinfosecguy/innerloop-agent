import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillsCli = resolve(root, 'node_modules/skills/bin/cli.mjs');

function stripTerminalEscapes(value) {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '');
}

function parseSkillFrontmatter(source, location) {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(source);
  assert.ok(match, `${location} must have YAML frontmatter`);
  const frontmatter = parseYaml(match[1]);
  assert.ok(frontmatter && typeof frontmatter === 'object' && !Array.isArray(frontmatter));
  return frontmatter;
}

function listSkills(source, cwd) {
  const environment = {
    ...process.env,
    DISABLE_TELEMETRY: '1',
    DO_NOT_TRACK: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };
  delete environment.INSTALL_INTERNAL_SKILLS;
  const result = spawnSync(process.execPath, [skillsCli, 'add', source, '--list'], {
    cwd,
    encoding: 'utf8',
    env: environment,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return stripTerminalEscapes(result.stdout);
}

function listedSkillNames(output) {
  return [...output.matchAll(/^\u2502 {4}([a-z][a-z0-9-]*)\s*$/gmu)]
    .map((match) => match[1])
    .sort();
}

async function isolatedPackage(prefix) {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), prefix));
  const isolatedRoot = resolve(temporaryRoot, 'innerloop-agent');
  await cp(root, isolatedRoot, {
    recursive: true,
    filter(source) {
      return !source.split('/').includes('node_modules');
    },
  });
  return { isolatedRoot, temporaryRoot };
}

function documentedRootCommands(readme) {
  const match = readme.match(
    /Validate and test the standalone package from its repository root:\n\n```sh\n([\s\S]*?)\n```/u,
  );
  assert.ok(match, 'README must contain the standalone root command block');
  return match[1].split('\n').map((line) => line.trim()).filter(Boolean);
}

test('distribution validator executes every integrity gate', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'release-manifest.json'), 'utf8'));
  const result = spawnSync(process.execPath, ['scripts/validate.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(`^validated 3 skills, ${manifest.clients.length} clients, ${manifest.assets.length} assets, `));
});

test('official skills CLI exposes the portable primary skill and three focused skills without an internal opt-in', async () => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'innerloop-skills-cli-'));
  try {
    const packageDocument = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    const discoverySkill = await readFile(resolve(root, 'discovery/skill.md'), 'utf8');
    assert.equal(packageDocument.devDependencies?.skills, '1.5.23');
    const frontmatter = parseSkillFrontmatter(discoverySkill, 'discovery/skill.md');
    assert.deepEqual(Object.keys(frontmatter).sort(), [
      'compatibility',
      'description',
      'license',
      'metadata',
      'name',
    ]);
    assert.equal(frontmatter.name, 'innerloop');
    assert.ok(frontmatter.metadata && typeof frontmatter.metadata === 'object' && !Array.isArray(frontmatter.metadata));
    assert.ok(Object.values(frontmatter.metadata).every((value) => typeof value === 'string'));
    assert.equal(Object.hasOwn(frontmatter.metadata, 'internal'), false);
    assert.equal(Object.hasOwn(frontmatter.metadata, 'openclaw'), false);

    const primaryOutput = listSkills(resolve(root, 'discovery'), temporaryRoot);
    assert.match(primaryOutput, /Found 1 skill\b/u);
    assert.deepEqual(listedSkillNames(primaryOutput), ['innerloop']);

    const focusedOutput = listSkills(resolve(root, 'skills'), temporaryRoot);
    assert.match(focusedOutput, /Found 3 skills\b/u);
    assert.deepEqual(
      listedSkillNames(focusedOutput),
      ['innerloop-explore', 'innerloop-onboard', 'innerloop-reflect'],
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('package safety defaults keep reviewed entries and secrets outside source control', async () => {
  const [ignore, readme, onboard, reflect, packageDocument] = await Promise.all([
    readFile(resolve(root, '.gitignore'), 'utf8'),
    readFile(resolve(root, 'README.md'), 'utf8'),
    readFile(resolve(root, 'skills/innerloop-onboard/SKILL.md'), 'utf8'),
    readFile(resolve(root, 'skills/innerloop-reflect/SKILL.md'), 'utf8'),
    readFile(resolve(root, 'package.json'), 'utf8').then(JSON.parse),
  ]);

  for (const pattern of ['**/entry.json', '**/first-entry*.json', '**/private-entry*.json']) {
    assert.match(ignore, new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace('\\*\\*', '.*').replace('\\*', '.*')}$`, 'mu'));
  }
  assert.deepEqual(packageDocument.os, ['darwin', 'linux']);
  for (const source of [readme, onboard, reflect]) {
    assert.match(source, /outside source control/iu);
    assert.match(source, /installed (?:plugin, extension, or )?skill director/iu);
  }
  for (const source of [onboard, reflect]) {
    assert.match(source, /--profile-dir "\$INNERLOOP_PROFILE_DIR"/u);
    assert.match(source, /--profile-name "\$INNERLOOP_PROFILE_NAME"/u);
    assert.doesNotMatch(source, /--identity /u);
    assert.doesNotMatch(source, /--ledger /u);
  }
});

test('focused onboarding status and backup block runs in a fresh shell', async () => {
  const onboardRoot = resolve(root, 'skills/innerloop-onboard');
  const onboard = await readFile(resolve(onboardRoot, 'SKILL.md'), 'utf8');
  const block = [...onboard.matchAll(/```sh\n([\s\S]*?)\n```/gu)]
    .map((match) => match[1])
    .find((candidate) => candidate.includes('backup-identity'));
  assert.ok(block, 'onboarding skill must contain a backup command block');
  assert.match(block, /^set -eu\n/u);

  const stateRoot = await mkdtemp(resolve(tmpdir(), 'innerloop-focused-backup-'));
  const innerloopDir = resolve(stateRoot, 'innerloop');
  const profileName = 'focused-backup-test';
  const profileDir = resolve(innerloopDir, 'profiles', profileName);
  try {
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    await writeFile(resolve(profileDir, '.innerloop-profile.json'), `${JSON.stringify({
      schema_version: 1,
      kind: 'innerloop.local-profile',
      profile_name: profileName,
    })}\n`, { mode: 0o600 });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    await writeFile(resolve(profileDir, 'identity.json'), `${JSON.stringify({
      private_key_pkcs8: Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' })).toString('base64'),
      public_key_spki: Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).toString('base64'),
      agent_id: 'agent_focused_backup_test',
      key_id: 'key_focused_backup_test',
      display_name: 'Focused Backup Test',
    })}\n`, { mode: 0o600 });

    const result = spawnSync('sh', ['-c', block], {
      cwd: onboardRoot,
      encoding: 'utf8',
      env: { ...process.env, XDG_STATE_HOME: stateRoot, INNERLOOP_PROFILE_NAME: profileName },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /"verified":true/u);
    assert.match(result.stdout, /"registered":true/u);
    assert.equal((await stat(resolve(profileDir, 'identity.backup.json'))).mode & 0o777, 0o600);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('distribution validator rejects prohibited text through its real lint gate', () => {
  const result = spawnSync(process.execPath, ['scripts/validate.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, INNERLOOP_VALIDATOR_PROBE: ['co', 'dex'].join('') },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /validation probe contains prohibited product-specific text/);
});

test('MCP publication gates the exact tag and metadata versions before authentication or publishing', async () => {
  const workflow = await readFile(resolve(root, '.github/workflows/publish-mcp.yml'), 'utf8');
  const gate = 'node scripts/verify-release-tag.mjs "$RELEASE_TAG"';
  const pinnedPublisherDigest = 'a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc';
  const gateIndex = workflow.indexOf(gate);
  assert.ok(workflow.includes('RELEASE_TAG: ${{ github.ref_name }}'));
  assert.ok(workflow.includes(`MCP_PUBLISHER_LINUX_AMD64_SHA256: ${pinnedPublisherDigest}`));
  assert.ok(workflow.includes('| sha256sum --check --strict -'));
  assert.ok(!workflow.includes('checksums.txt'), 'publisher trust must not depend on a sibling checksum asset');
  assert.ok(gateIndex > 0, 'publish workflow is missing the release tag gate');
  for (const credentialedCommand of [
    './mcp-publisher login github-oidc',
    './mcp-publisher publish server.json',
  ]) {
    const credentialedIndex = workflow.indexOf(credentialedCommand);
    assert.ok(credentialedIndex > gateIndex, `${credentialedCommand} must run after the release tag gate`);
  }
});

test('release tag gate accepts only the exact four-document release version', async () => {
  const { isolatedRoot, temporaryRoot } = await isolatedPackage('innerloop-release-tag-');
  try {
    const packageDocument = JSON.parse(await readFile(resolve(isolatedRoot, 'package.json'), 'utf8'));
    const expectedTag = `v${packageDocument.version}`;
    const exact = spawnSync(
      process.execPath,
      ['scripts/verify-release-tag.mjs', expectedTag],
      { cwd: isolatedRoot, encoding: 'utf8' },
    );
    assert.equal(exact.status, 0, exact.stderr || exact.stdout);
    assert.match(exact.stdout, new RegExp(`verified ${expectedTag.replaceAll('.', '\\.')} across 4 release documents`));

    const wrongTag = spawnSync(
      process.execPath,
      ['scripts/verify-release-tag.mjs', `${expectedTag}.1`],
      { cwd: isolatedRoot, encoding: 'utf8' },
    );
    assert.notEqual(wrongTag.status, 0);
    assert.match(wrongTag.stderr, /must exactly equal/);

    const listingPath = resolve(isolatedRoot, 'listing.json');
    const listing = JSON.parse(await readFile(listingPath, 'utf8'));
    listing.version = '0.0.0-version-mismatch';
    await writeFile(listingPath, `${JSON.stringify(listing, null, 2)}\n`, 'utf8');
    const mismatched = spawnSync(
      process.execPath,
      ['scripts/verify-release-tag.mjs', expectedTag],
      { cwd: isolatedRoot, encoding: 'utf8' },
    );
    assert.notEqual(mismatched.status, 0);
    assert.match(mismatched.stderr, /listing\.json version .* differs from package\.json version/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('standalone package installs, validates, tests, and self-tests without the monorepo', {
  skip: process.env.INNERLOOP_ISOLATION_CHILD === '1',
  timeout: 180_000,
}, async () => {
  const { isolatedRoot, temporaryRoot } = await isolatedPackage('innerloop-package-isolation-');
  try {
    const environment = { ...process.env, INNERLOOP_ISOLATION_CHILD: '1' };
    const install = spawnSync(
      'pnpm',
      ['install', '--frozen-lockfile', '--ignore-workspace'],
      { cwd: isolatedRoot, encoding: 'utf8', env: environment },
    );
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const readme = await readFile(resolve(isolatedRoot, 'README.md'), 'utf8');
    const rootCommands = documentedRootCommands(readme);
    assert.deepEqual(rootCommands, ['pnpm validate', 'pnpm test']);
    for (const commandLine of rootCommands) {
      const [command, ...args] = commandLine.split(/\s+/u);
      const result = spawnSync(command, args, { cwd: isolatedRoot, encoding: 'utf8', env: environment });
      assert.equal(result.status, 0, `${commandLine}\n${result.stderr || result.stdout}`);
    }

    for (const [command, args] of [
      [process.execPath, ['scripts/innerloop-client.mjs', 'self-test']],
      [process.execPath, ['skills/innerloop-onboard/scripts/innerloop-client.mjs', 'self-test']],
      [process.execPath, ['skills/innerloop-onboard/scripts/verify-client.mjs']],
      [process.execPath, ['skills/innerloop-reflect/scripts/innerloop-client.mjs', 'self-test']],
      [process.execPath, ['skills/innerloop-reflect/scripts/verify-client.mjs']],
    ]) {
      const result = spawnSync(command, args, { cwd: isolatedRoot, encoding: 'utf8', env: environment });
      assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
    }

    const versionedPaths = [
      'package.json',
      'server.json',
      'listing.json',
      'release-manifest.json',
    ];
    for (const path of versionedPaths) {
      const absolutePath = resolve(isolatedRoot, path);
      const original = await readFile(absolutePath, 'utf8');
      const document = JSON.parse(original);
      document.version = '0.0.0-version-mismatch';
      await writeFile(absolutePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      const result = spawnSync('pnpm', ['validate'], {
        cwd: isolatedRoot,
        encoding: 'utf8',
        env: environment,
      });
      assert.notEqual(result.status, 0, `${path} version mismatch was accepted`);
      assert.match(result.stderr, /versions differ/);
      await writeFile(absolutePath, original, 'utf8');
    }

    const focusedSkillPath = resolve(isolatedRoot, 'skills/innerloop-onboard/SKILL.md');
    const focusedSkillSource = await readFile(focusedSkillPath, 'utf8');
    await writeFile(
      focusedSkillPath,
      focusedSkillSource.replace(/^(  version:) "[^"]+"$/mu, '$1 "0.0.0-version-mismatch"'),
      'utf8',
    );
    const mismatchedSkill = spawnSync('pnpm', ['validate'], {
      cwd: isolatedRoot,
      encoding: 'utf8',
      env: environment,
    });
    assert.notEqual(mismatchedSkill.status, 0, 'focused skill metadata version mismatch was accepted');
    assert.match(mismatchedSkill.stderr, /metadata version differs from package version/);
    await writeFile(focusedSkillPath, focusedSkillSource, 'utf8');

    const releaseManifestPath = resolve(isolatedRoot, 'release-manifest.json');
    const releaseManifestSource = await readFile(releaseManifestPath, 'utf8');
    const releaseManifest = JSON.parse(releaseManifestSource);
    releaseManifest.manifests = releaseManifest.manifests.filter(
      ({ path }) => path !== 'server.json' && path !== 'listing.json',
    );
    await writeFile(releaseManifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`, 'utf8');
    const incompleteCoverage = spawnSync('pnpm', ['validate'], {
      cwd: isolatedRoot,
      encoding: 'utf8',
      env: environment,
    });
    assert.notEqual(incompleteCoverage.status, 0, 'missing public manifest coverage was accepted');
    assert.match(incompleteCoverage.stderr, /release manifest must pin every public package manifest/);
    await writeFile(releaseManifestPath, releaseManifestSource, 'utf8');

    for (const path of ['server.json', 'listing.json']) {
      const absolutePath = resolve(isolatedRoot, path);
      const original = await readFile(absolutePath, 'utf8');
      const document = JSON.parse(original);
      document.description = `${document.description} altered`;
      await writeFile(absolutePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      const result = spawnSync('pnpm', ['validate'], {
        cwd: isolatedRoot,
        encoding: 'utf8',
        env: environment,
      });
      assert.notEqual(result.status, 0, `${path} digest mismatch was accepted`);
      assert.match(result.stderr, new RegExp(`${path.replace('.', '\\.')} manifest digest mismatch`));
      await writeFile(absolutePath, original, 'utf8');
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
