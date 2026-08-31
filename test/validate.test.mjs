import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

test('distribution validator executes every integrity gate', () => {
  const result = spawnSync(process.execPath, ['scripts/validate.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^validated 3 skills, 5 clients, 2 assets, /);
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
