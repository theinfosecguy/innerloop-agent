import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gitVerifier = resolve(root, 'scripts/verify-git-release.mjs');
const liveVerifier = resolve(root, 'scripts/verify-live-release.mjs');

function command(commandName, args, cwd) {
  const result = spawnSync(commandName, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${commandName} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function makeSignedRepository({ tagKind = 'signed', advanceMain = false, trustSigningKey = true } = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'innerloop-git-release-'));
  const scriptsDirectory = resolve(directory, 'scripts');
  const githubDirectory = resolve(directory, '.github');
  await mkdir(scriptsDirectory, { recursive: true });
  await mkdir(githubDirectory, { recursive: true });
  await copyFile(gitVerifier, resolve(scriptsDirectory, 'verify-git-release.mjs'));
  await writeFile(resolve(directory, 'package.json'), '{"version":"9.8.7","type":"module"}\n', 'utf8');

  const signingKey = resolve(directory, 'release-key');
  const trustedKey = trustSigningKey ? signingKey : resolve(directory, 'trusted-key');
  command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', signingKey], directory);
  if (!trustSigningKey) command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', trustedKey], directory);
  const trustedPublicKey = (await readFile(`${trustedKey}.pub`, 'utf8')).trim().split(/\s+/u).slice(0, 2).join(' ');
  await writeFile(resolve(githubDirectory, 'release-signers'), `release@example.invalid ${trustedPublicKey}\n`, 'utf8');

  command('git', ['init', '--quiet', '--initial-branch=main'], directory);
  command('git', ['config', 'user.name', 'Release Test'], directory);
  command('git', ['config', 'user.email', 'release@example.invalid'], directory);
  command('git', ['config', 'commit.gpgsign', 'false'], directory);
  command('git', ['config', 'gpg.format', 'ssh'], directory);
  command('git', ['config', 'user.signingkey', signingKey], directory);
  command('git', ['add', '.'], directory);
  command('git', ['commit', '--quiet', '-m', 'release fixture'], directory);

  if (tagKind === 'signed') {
    command('git', ['tag', '--sign', '--annotate', 'v9.8.7', '--message', 'v9.8.7'], directory);
  } else if (tagKind === 'annotated') {
    command('git', ['tag', '--annotate', 'v9.8.7', '--message', 'v9.8.7'], directory);
  } else {
    command('git', ['tag', 'v9.8.7'], directory);
  }

  if (advanceMain) {
    await writeFile(resolve(directory, 'after-tag.txt'), 'main advanced\n', 'utf8');
    command('git', ['add', 'after-tag.txt'], directory);
    command('git', ['commit', '--quiet', '-m', 'advance main fixture'], directory);
  }

  return directory;
}

function runGitVerifier(directory) {
  return spawnSync(
    process.execPath,
    ['scripts/verify-git-release.mjs', 'v9.8.7', 'refs/heads/main', '.github/release-signers'],
    { cwd: directory, encoding: 'utf8' },
  );
}

async function withSignedRepository(options, callback) {
  const directory = await makeSignedRepository(options);
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('Git release gate accepts a trusted signed annotated tag at exact main HEAD', async () => {
  await withSignedRepository({}, async (directory) => {
    const result = runGitVerifier(directory);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /verified signed annotated v9\.8\.7 at exact main commit/u);
  });
});

test('Git release gate rejects lightweight and unsigned annotated tags', async () => {
  for (const tagKind of ['lightweight', 'annotated']) {
    await withSignedRepository({ tagKind }, async (directory) => {
      const result = runGitVerifier(directory);
      assert.notEqual(result.status, 0, `${tagKind} tag was accepted`);
      assert.match(result.stderr, tagKind === 'lightweight' ? /must be an annotated tag/u : /must have a valid signature/u);
    });
  }
});

test('Git release gate rejects an untrusted signer and a tag behind main', async () => {
  await withSignedRepository({ trustSigningKey: false }, async (directory) => {
    const result = runGitVerifier(directory);
    assert.notEqual(result.status, 0, 'untrusted signer was accepted');
    assert.match(result.stderr, /must have a valid signature/u);
  });
  await withSignedRepository({ advanceMain: true }, async (directory) => {
    const result = runGitVerifier(directory);
    assert.notEqual(result.status, 0, 'tag behind main was accepted');
    assert.match(result.stderr, /must exactly equal refs\/heads\/main commit/u);
  });
});

test('publish workflow isolates OIDC behind all uncredentialed release gates', async () => {
  const workflow = await readFile(resolve(root, '.github/workflows/publish-mcp.yml'), 'utf8');
  const validateIndex = workflow.indexOf('  validate:');
  const publishIndex = workflow.indexOf('  publish:');
  assert.ok(validateIndex > 0 && publishIndex > validateIndex, 'workflow must split validate and publish jobs');
  const validationJob = workflow.slice(validateIndex, publishIndex);
  const publishingJob = workflow.slice(publishIndex);

  assert.match(validationJob, /permissions:\n\s+contents: read/u);
  assert.doesNotMatch(validationJob, /id-token:\s*write/u, 'validation must not receive OIDC permission');
  assert.match(validationJob, /fetch-depth:\s*0/u);
  assert.match(validationJob, /persist-credentials:\s*false/u);
  assert.match(validationJob, /refs\/heads\/main:refs\/remotes\/origin\/main/u);
  assert.match(validationJob, /verify-git-release\.mjs "\$RELEASE_TAG" refs\/remotes\/origin\/main \.github\/release-signers/u);
  assert.match(validationJob, /node scripts\/verify-live-release\.mjs/u);
  assert.match(validationJob, /\.\/mcp-publisher validate server\.json/u);

  assert.match(publishingJob, /needs:\s*validate/u);
  assert.match(publishingJob, /environment:\n\s+name:\s*mcp-registry-publish/u);
  assert.match(publishingJob, /permissions:\n\s+contents:\s*read\n\s+id-token:\s*write/u);
  assert.match(publishingJob, /persist-credentials:\s*false/u);
  assert.doesNotMatch(publishingJob, /(?:node|pnpm|npm|yarn|bun)\s+(?:scripts\/|run\s+)/u, 'OIDC job must not execute repository scripts');
  const loginIndex = publishingJob.indexOf('./mcp-publisher login github-oidc');
  const publishCommandIndex = publishingJob.indexOf('./mcp-publisher publish server.json');
  assert.ok(loginIndex > 0 && publishCommandIndex > loginIndex, 'OIDC login must occur immediately before publication');

  const workflowCurlCount = (workflow.match(/\bcurl\s+/gu) ?? []).length;
  assert.equal(workflowCurlCount, 2, 'publish workflow must have exactly two network downloads');
  assert.equal((workflow.match(/\bcurl --disable /gu) ?? []).length, workflowCurlCount, 'both publisher downloads must disable ambient curl configuration first');
  for (const requiredBound of [
    "--proto '=https' --proto-redir '=https' --tlsv1.2",
    '--connect-timeout 10 --max-time 120 --max-filesize 50000000',
    '--retry 3 --retry-delay 1 --retry-max-time 120',
  ]) {
    assert.equal((workflow.split(requiredBound).length - 1), 2, `both publisher downloads must include ${requiredBound}`);
  }
});

test('CI covers the minimum runtime and active Node releases on Linux and macOS', async () => {
  const workflow = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /push:\n\s+branches:\n\s+- main\n\s+- "release-candidate\/\*\*"/u, 'candidate SHAs must earn the same push checks before protected-main promotion');
  assert.match(workflow, /os:\n\s+- ubuntu-latest\n\s+- macos-latest/u);
  assert.match(workflow, /node-version:\n\s+- 22\.20\.0\n\s+- 24\.x\n\s+- 26\.x/u);
  assert.match(workflow, /persist-credentials:\s*false/u);
});

test('README contains a copyable exact A2A v1.0 discovery request', async () => {
  const readme = await readFile(resolve(root, 'README.md'), 'utf8');
  assert.match(readme, /https:\/\/innerloop-gateway\.neagley-dev\.workers\.dev\/\.well-known\/agent-card\.json/u);
  assert.match(readme, /https:\/\/innerloop-gateway\.neagley-dev\.workers\.dev\/a2a\/v1\/message:send/u);
  assert.match(readme, /--header 'Content-Type: application\/a2a\+json'/u);
  assert.match(readme, /--header 'A2A-Version: 1\.0'/u);
  assert.match(readme, /"operation": "innerloop\.discovery\.get"/u);
  assert.match(readme, /"acceptedOutputModes": \["application\/json"\]/u);
  const readmeCurlCount = (readme.match(/^curl\s+/gmu) ?? []).length;
  assert.equal(readmeCurlCount, 2, 'README must have exactly two curl examples');
  assert.equal((readme.match(/^curl --disable --proto '=https' --tlsv1\.2/gmu) ?? []).length, readmeCurlCount, 'both A2A examples must disable ambient curl configuration and require HTTPS');
  assert.equal((readme.match(/--connect-timeout 5 --max-time 20 --max-filesize 1048576/gu) ?? []).length, 2, 'both A2A examples must bound connection time, total time, and response size');
});

test('generated discovery skill keeps the production client download bounded', async () => {
  const skill = await readFile(resolve(root, 'discovery/skill.md'), 'utf8');
  assert.match(skill, /curl --disable --proto '=https' --tlsv1\.2 --fail --show-error \\\n\s+--connect-timeout 10 \\\n\s+--max-time 60[\s\S]*?--retry-max-time 60[\s\S]*?--max-filesize 262144/u);
});

test('public install commands pin the package release instead of moving main', async () => {
  const [readme, cursor, packageDocument] = await Promise.all([
    readFile(resolve(root, 'README.md'), 'utf8'),
    readFile(resolve(root, 'adapters/cursor/CHANNEL.md'), 'utf8'),
    readFile(resolve(root, 'package.json'), 'utf8').then(JSON.parse),
  ]);
  const escapedVersion = packageDocument.version.replaceAll('.', '\\.');
  assert.match(readme, new RegExp(`theinfosecguy/innerloop-agent@v${packageDocument.version.replaceAll('.', '\\.')}\\b`, 'u'));
  assert.match(readme, new RegExp(`--ref v${packageDocument.version.replaceAll('.', '\\.')}\\b`, 'u'));
  assert.match(readme, new RegExp(`theinfosecguy/innerloop-agent#v${packageDocument.version.replaceAll('.', '\\.')}\\b`, 'u'));
  assert.match(cursor, new RegExp(`theinfosecguy/innerloop-agent#v${escapedVersion}\\b`, 'u'));
  assert.doesNotMatch(`${readme}\n${cursor}`, /npx skills add theinfosecguy\/innerloop-agent(?:\s|$)/u);
});

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function surfaceHeaders(body, type) {
  return {
    'content-type': type,
    'cache-control': 'public, max-age=300, stale-while-revalidate=86400, no-transform',
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
    etag: `"sha256-${digest(body)}"`,
  };
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function startReleaseServer({ corruptClient = false, corruptSurfacePath } = {}) {
  const [manifest, client] = await Promise.all([
    readFile(resolve(root, 'release-manifest.json'), 'utf8').then(JSON.parse),
    readFile(resolve(root, 'scripts/innerloop-client.mjs')),
  ]);
  assert.equal(manifest.surfaces.length, 5);
  const surfaceBodies = new Map(await Promise.all(manifest.surfaces.map(async (surface) => [
    surface.path,
    [Buffer.from(await readFile(resolve(root, surface.packagePath))), surface.contentType],
  ])));
  if (corruptSurfacePath) {
    const selected = surfaceBodies.get(corruptSurfacePath);
    assert.ok(selected, `unknown corrupt surface ${corruptSurfacePath}`);
    selected[0][0] ^= 1;
  }
  const clientBody = Buffer.from(client);
  if (corruptClient) clientBody[0] ^= 1;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const surface = surfaceBodies.get(url.pathname);
      if (request.method === 'GET' && surface) {
        const [body, type] = surface;
        response.writeHead(200, surfaceHeaders(body, type));
        response.end(body);
        return;
      }
      if (request.method === 'GET' && url.pathname === new URL(manifest.urls.client).pathname) {
        response.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'public, max-age=31536000, immutable',
          'access-control-allow-origin': '*',
          'x-content-type-options': 'nosniff',
          'x-innerloop-sha256': manifest.bundledClient.sha256,
        });
        response.end(clientBody);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/mcp') {
        const body = JSON.parse(await requestBody(request));
        if (body.method === 'notifications/initialized') {
          response.writeHead(202, { 'cache-control': 'no-store' });
          response.end();
          return;
        }
        let result;
        if (body.method === 'initialize' && body.params?.protocolVersion === '2025-06-18') {
          result = {
            protocolVersion: '2025-06-18',
            capabilities: { extensions: { 'io.modelcontextprotocol/skills': {} } },
            serverInfo: { name: 'innerloop', version: manifest.version },
          };
        } else if (body.method === 'tools/list') {
          result = { tools: [
            'innerloop_start_registration',
            'innerloop_complete_registration',
            'innerloop_prepare_entry',
            'innerloop_submit_signed_entry',
            'innerloop_read_public_feed',
          ].map((name) => ({ name, inputSchema: {}, outputSchema: {} })) };
        } else if (body.method === 'skills/list') {
          result = { skills: manifest.skills };
        } else if (body.method === 'skills/get') {
          const skill = manifest.skills.find((candidate) => candidate.uri === body.params?.uri);
          if (!skill) {
            response.writeHead(400).end();
            return;
          }
          result = { skill };
        } else if (body.method === 'resources/read') {
          const resource = manifest.skills.flatMap((skill) => skill.resources)
            .find((candidate) => candidate.uri === body.params?.uri);
          const match = /^skill:\/\/([^/]+)\/(.+)$/u.exec(resource?.uri ?? '');
          if (!resource || !match || match[2].includes('..')) {
            response.writeHead(400).end();
            return;
          }
          const text = await readFile(resolve(root, 'skills', match[1], match[2]), 'utf8');
          const mimeType = resource.uri.endsWith('.md')
            ? 'text/markdown'
            : resource.uri.endsWith('.json')
              ? 'application/json'
              : 'text/javascript';
          result = { contents: [{ uri: resource.uri, mimeType, text }] };
        } else {
          response.writeHead(400).end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result,
        }));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/a2a/v1/message:send') {
        const body = JSON.parse(await requestBody(request));
        const part = body.message?.parts?.[0];
        if (
          request.headers['a2a-version'] !== '1.0' ||
          request.headers['content-type'] !== 'application/a2a+json' ||
          part?.data?.operation !== 'innerloop.discovery.get' ||
          part?.mediaType !== 'application/json'
        ) {
          response.writeHead(400).end();
          return;
        }
        response.writeHead(200, {
          'content-type': 'application/a2a+json',
          'a2a-version': '1.0',
          'cache-control': 'no-store',
        });
        response.end(JSON.stringify({
          message: {
            parts: [{
              data: {
                operation: 'innerloop.discovery.get',
                ok: true,
                result: {
                  name: 'Innerloop',
                  writing_is_optional: true,
                  links: { a2a: manifest.urls.a2a },
                },
              },
            }],
          },
        }));
        return;
      }
      response.writeHead(404).end();
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    },
  };
}

function runLiveVerifier(origin) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [liveVerifier, '--origin', origin, '--allow-localhost'],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

test('live release gate verifies discovery, client integrity, MCP, and exact A2A discovery', { timeout: 30_000 }, async () => {
  const server = await startReleaseServer();
  try {
    const result = await runLiveVerifier(server.origin);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /5 pinned surfaces, immutable client, 3 MCP skills, \d+ MCP resources, and A2A/u);
  } finally {
    await server.close();
  }
});

test('live release gate rejects a discovery surface that differs by one byte', { timeout: 30_000 }, async () => {
  const server = await startReleaseServer({ corruptSurfacePath: '/heartbeat.md' });
  try {
    const result = await runLiveVerifier(server.origin);
    assert.notEqual(result.status, 0, 'corrupt deployed discovery surface was accepted');
    assert.match(result.stderr, /heartbeat digest differs from the release manifest/u);
  } finally {
    await server.close();
  }
});

test('live release gate rejects a deployed client that differs by one byte', { timeout: 30_000 }, async () => {
  const server = await startReleaseServer({ corruptClient: true });
  try {
    const result = await runLiveVerifier(server.origin);
    assert.notEqual(result.status, 0, 'corrupt deployed client was accepted');
    assert.match(result.stderr, /versioned client digest differs from the release manifest/u);
  } finally {
    await server.close();
  }
});
