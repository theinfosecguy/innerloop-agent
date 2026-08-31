import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { extname, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function skillMetadataVersion(source, location) {
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/u);
  assert(frontmatter, `${location} is missing YAML frontmatter`);
  const version = frontmatter[1].match(/^  version:\s*"([^"]+)"\s*$/mu);
  assert(version, `${location} is missing metadata.version`);
  return version[1];
}

async function filesBelow(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') files.push(...await filesBelow(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function json(path) {
  return JSON.parse(await readFile(resolve(root, path), 'utf8'));
}

const releaseAuthor = Object.freeze({ name: 'Keshav Malik', email: 'keshavaarav22@gmail.com' });
const publicRepository = 'https://github.com/theinfosecguy/innerloop-agent';
const publicRepositoryId = '1351977173';
const productionOrigins = Object.freeze({
  gateway: 'https://innerloop-gateway.neagley-dev.workers.dev',
  api: 'https://innerloop-api.neagley-dev.workers.dev',
  web: 'https://innerloop.neagley-dev.workers.dev',
});
const skillDefinitions = Object.freeze([
  { name: 'innerloop-onboard', directory: 'skills/innerloop-onboard', clientResource: true },
  { name: 'innerloop-reflect', directory: 'skills/innerloop-reflect', clientResource: true },
  { name: 'innerloop-explore', directory: 'skills/innerloop-explore', clientResource: false },
]);
const telemetryAllowlists = Object.freeze({
  sources: ['direct', 'gateway', 'openai', 'claude', 'cursor', 'gemini', 'openclaw', 'gateway-skill', 'mcp-registry', 'skill-url', 'a2a-card', 'heartbeat', 'web', 'cli'],
  runtimes: ['node', 'python', 'cloudflare-worker', 'browser', 'unknown'],
  clientVersions: ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.3.1', '1.3.2', '1.3.3', '1.3.4', 'unknown'],
});

function assertReleaseAuthor(value, location) {
  assert(JSON.stringify(value?.author) === JSON.stringify(releaseAuthor), `${location} release author is missing or inconsistent`);
}

function localResourcePath(skillName, uri) {
  const prefix = `skill://${skillName}/`;
  assert(uri.startsWith(prefix), `${uri} is outside ${skillName}`);
  const suffix = uri.slice(prefix.length);
  assert(suffix.length > 0 && !suffix.includes('..') && !suffix.startsWith('/'), `${uri} has an unsafe path`);
  if (suffix === 'SKILL.md' || suffix.startsWith('references/')) {
    return resolve(root, 'skills', skillName, suffix);
  }
  if (suffix.startsWith('scripts/')) return resolve(root, 'skills', skillName, suffix);
  throw new Error(`${uri} has no package resource mapping`);
}

const packageDocument = await json('package.json');
const manifest = await json('release-manifest.json');
const registry = await json('server.json');
const listing = await json('listing.json');
assert(packageDocument.private === true, 'distribution package must remain private until publication is intentional');
assert(packageDocument.author === `${releaseAuthor.name} <${releaseAuthor.email}>`, 'distribution package author is inconsistent');
assert(packageDocument.repository?.url === `${publicRepository}.git`, 'distribution package repository is inconsistent');
assert(packageDocument.engines?.node === '>=22.20.0', 'distribution package Node.js floor is not canonical');
assert(JSON.stringify(packageDocument.os) === JSON.stringify(['darwin', 'linux']), 'distribution package must fail closed outside macOS and Linux');
assert(manifest.version === packageDocument.version, 'release manifest and package versions differ');
assert(registry.version === packageDocument.version, 'server.json and package versions differ');
assert(listing.version === packageDocument.version, 'listing.json and package versions differ');
assert(manifest.urls.gateway === productionOrigins.gateway, 'production gateway URL is not canonical');
assert(manifest.urls.api === productionOrigins.api, 'production API URL is not canonical');
assert(manifest.urls.web === productionOrigins.web, 'production web URL is not canonical');
assert(manifest.protocols.mcp.skillsExtension === 'io.modelcontextprotocol/skills', 'MCP skills extension is missing');
assert(manifest.skills.length === skillDefinitions.length, 'exactly three focused skills are required');
const currentClient = manifest.clients.find((client) => client.version === manifest.bundledClient.version);
assert(currentClient?.released === true, 'the bundled production client must be frozen before distribution validation');
assert(manifest.skills.map((skill) => skill.frontmatter.name).sort().join(',') === skillDefinitions.map((skill) => skill.name).sort().join(','), 'focused skill set is inconsistent');

for (const skill of manifest.skills) {
  const name = skill.frontmatter.name;
  const configured = skillDefinitions.find((candidate) => candidate.name === name);
  assert(configured, `${name} is not in the focused skill set`);
  const skillSource = await readFile(resolve(root, configured.directory, 'SKILL.md'), 'utf8');
  assert(
    skillMetadataVersion(skillSource, skill.uri) === packageDocument.version,
    `${skill.uri} metadata version differs from package version`,
  );
  assert(
    skillSource.includes('read-only MCP tool and public HTTP interfaces are platform independent'),
    `${skill.uri} read-only platform boundary is missing`,
  );
  assert(skill.resources.length === (configured.clientResource ? 4 : 1), `${skill.uri} has an incomplete resource set`);
  const uris = new Set(skill.resources.map((resource) => resource.uri));
  for (const resource of skill.resources) {
    const source = await readFile(localResourcePath(name, resource.uri));
    assert(resource.digest === `sha256:${hash(source)}`, `${resource.uri} digest mismatch`);
    assert(resource.size === source.byteLength, `${resource.uri} size mismatch`);
  }
  if (configured.clientResource) {
    assert(skillSource.includes('Node.js 22.20.0 or newer'), `${skill.uri} Node.js floor is not canonical`);
    assert(/requires macOS or Linux/iu.test(skillSource), `${skill.uri} supported platform boundary is missing`);
    assert(skillSource.includes('outside source control'), `${skill.uri} source-control boundary is missing`);
    assert(skillSource.includes('installed skill director'), `${skill.uri} install-directory boundary is missing`);
    assert(skillSource.includes('INNERLOOP_DIR'), `${skill.uri} operator state directory is missing`);
  }
  assert(uris.has(skill.uri), `${skill.uri} is missing SKILL.md`);
  if (configured.clientResource) {
    assert(skillSource.includes('references/client-integrity.json'), `${skill.uri} does not declare client integrity data`);
    assert(skillSource.includes('scripts/innerloop-client.mjs'), `${skill.uri} does not declare its bundled client`);
    assert(uris.has(`skill://${name}/references/client-integrity.json`), `${skill.uri} is missing client integrity data`);
    assert(uris.has(`skill://${name}/scripts/innerloop-client.mjs`), `${skill.uri} is missing its bundled client`);
    assert(uris.has(`skill://${name}/scripts/verify-client.mjs`), `${skill.uri} is missing its integrity verifier`);
    const integrity = await json(`${configured.directory}/references/client-integrity.json`);
    assert(integrity.client.sha256 === manifest.bundledClient.sha256, `${skill.uri} client integrity digest differs`);
    assert(integrity.client.size === manifest.bundledClient.size, `${skill.uri} client integrity size differs`);
    const focusedClient = await readFile(resolve(root, configured.directory, 'scripts/innerloop-client.mjs'));
    assert(Buffer.compare(focusedClient, await readFile(resolve(root, manifest.bundledClient.path))) === 0, `${skill.uri} focused install client differs from package client`);
    const verifier = await readFile(resolve(root, configured.directory, 'scripts/verify-client.mjs'), 'utf8');
    assert(verifier.includes('bundled client integrity check failed'), `${skill.uri} integrity verifier is incomplete`);
    const verification = spawnSync(
      process.execPath,
      [resolve(root, configured.directory, 'scripts/verify-client.mjs')],
      { cwd: resolve(root, configured.directory), encoding: 'utf8' },
    );
    assert(
      verification.status === 0,
      `${skill.uri} integrity verifier failed: ${verification.stderr || verification.stdout}`,
    );
  }
  const platformMetadata = await readFile(resolve(root, configured.directory, 'agents/openai.yaml'), 'utf8');
  assert(platformMetadata.includes('--distribution-source openai --runtime node'), `${skill.uri} lacks exact OpenAI channel metadata`);
  assert(platformMetadata.includes(manifest.urls.mcp), `${skill.uri} platform metadata has the wrong MCP URL`);
}

const bundledClient = await readFile(resolve(root, manifest.bundledClient.path));
assert(manifest.bundledClient.sha256 === hash(bundledClient), 'bundled client digest mismatch');
assert(manifest.bundledClient.size === bundledClient.byteLength, 'bundled client size mismatch');
assert(bundledClient.includes(Buffer.from("export const MINIMUM_NODE_VERSION = '22.20.0';")), 'bundled client Node.js floor is not canonical');
assert(bundledClient.includes(Buffer.from('Requires Node.js ${MINIMUM_NODE_VERSION} or newer.')), 'bundled client help omits its Node.js floor');
for (const args of [
  ['--check', manifest.bundledClient.path],
  [manifest.bundledClient.path],
  [manifest.bundledClient.path, '--help'],
  [manifest.bundledClient.path, 'onboard', '--help'],
  [manifest.bundledClient.path, 'reflect', '--help'],
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  assert(result.status === 0, `client validation failed for ${args.slice(1).join(' ') || 'no arguments'}: ${result.stderr || result.stdout}`);
}

for (const client of manifest.clients) {
  assert(/^\/[a-z0-9./-]+$/.test(client.path), `${client.path} client path is unsafe`);
  assert(/^[a-f0-9]{64}$/.test(client.sha256), `${client.path} digest is malformed`);
  assert(client.apiOrigin.startsWith('https://'), `${client.path} API origin is unsafe`);
  assert(Array.isArray(client.validationApiOrigins) && client.validationApiOrigins.every((origin) => origin.startsWith('https://')), `${client.path} validation origins are unsafe`);
}

assert(manifest.assets.map((asset) => asset.path).sort().join(',') === 'assets/innerloop-mark.svg,assets/marketplace-icon.png', 'release assets are incomplete');
for (const asset of manifest.assets) {
  const source = await readFile(resolve(root, asset.path));
  assert(asset.publicPath === `/${asset.path}`, `${asset.path} public path mismatch`);
  assert(asset.sha256 === hash(source) && asset.size === source.byteLength, `${asset.path} integrity mismatch`);
}

const genericMcp = await json('.mcp.json');
assert(genericMcp.mcpServers?.innerloop?.type === 'http', 'generic MCP transport is not HTTP');
assert(genericMcp.mcpServers.innerloop.url === manifest.urls.mcp, 'generic MCP URL differs from release manifest');
const genericPlugin = await json('plugin.json');
assert(genericPlugin.version === manifest.version, 'Agent Plugin version differs from release manifest');
assertReleaseAuthor(genericPlugin, 'Agent Plugin');
const agentPluginMcp = await json('mcp.json');
const ajv = new Ajv2020({ allErrors: true, strict: true });
const pluginSchema = await json('schemas/agent-plugins-1.0.0/plugin.schema.json');
const mcpSchema = await json('schemas/agent-plugins-1.0.0/mcp.schema.json');
const validatePlugin = ajv.compile(pluginSchema);
const validateMcp = ajv.compile(mcpSchema);
assert(validatePlugin(genericPlugin), `Agent Plugin manifest violates its canonical schema: ${ajv.errorsText(validatePlugin.errors)}`);
assert(validateMcp(agentPluginMcp), `Agent Plugin MCP config violates its canonical schema: ${ajv.errorsText(validateMcp.errors)}`);
assert(agentPluginMcp.mcpServers?.innerloop?.type === 'streamable-http', 'Agent Plugin MCP transport is not Streamable HTTP');
assert(agentPluginMcp.mcpServers.innerloop.url === manifest.urls.mcp, 'Agent Plugin MCP URL differs from release manifest');
for (const generatedManifest of manifest.manifests) {
  const source = await readFile(resolve(root, generatedManifest.path));
  assert(generatedManifest.sha256 === hash(source), `${generatedManifest.path} manifest digest mismatch`);
  assert(generatedManifest.size === source.byteLength, `${generatedManifest.path} manifest size mismatch`);
}
assert(
  manifest.manifests.map((entry) => entry.path).sort().join(',')
    === 'listing.json,mcp.json,plugin.json,server.json',
  'release manifest must pin every public package manifest',
);
const claudePlugin = await json('.claude-plugin/plugin.json');
assert(claudePlugin.version === manifest.version, 'Claude plugin version differs from release manifest');
assertReleaseAuthor(claudePlugin, 'Claude plugin');
const claudeMarketplace = await json('.claude-plugin/marketplace.json');
assert(claudeMarketplace.$schema === 'https://json.schemastore.org/claude-code-marketplace.json', 'Claude marketplace schema is missing');
assert(claudeMarketplace.name === 'innerloop-agent-tools', 'Claude marketplace name is not canonical');
assert(claudeMarketplace.owner?.name === 'Innerloop', 'Claude marketplace owner is not canonical');
assert(claudeMarketplace.metadata?.version === manifest.version, 'Claude marketplace metadata version differs');
assert(claudeMarketplace.plugins?.length === 1, 'Claude marketplace must contain exactly one plugin');
assert(claudeMarketplace.plugins[0]?.name === 'innerloop-agent', 'Claude marketplace plugin name is not canonical');
assert(claudeMarketplace.plugins[0]?.source === './', 'Claude marketplace plugin source must be the repository root');
assert(claudeMarketplace.plugins[0]?.version === manifest.version, 'Claude marketplace plugin version differs');
assert(claudeMarketplace.plugins[0]?.repository === publicRepository, 'Claude marketplace repository differs');
assertReleaseAuthor(claudeMarketplace.plugins[0], 'Claude marketplace plugin');
const gemini = await json('gemini-extension.json');
assert(gemini.version === manifest.version, 'Gemini extension version differs from release manifest');
assert(gemini.mcpServers?.innerloop?.httpUrl === manifest.urls.mcp, 'Gemini MCP URL differs from release manifest');
assert(registry.name === 'io.github.theinfosecguy/innerloop', 'MCP Registry namespace is not the authenticated publisher');
assert(registry.description.length <= 100, 'MCP Registry description exceeds 100 characters');
assert(registry.repository?.url === publicRepository, 'MCP Registry repository differs from canonical config');
assert(registry.repository?.id === publicRepositoryId, 'MCP Registry repository ID differs from the permanent GitHub repository ID');
assert(registry.remotes?.[0]?.url === manifest.urls.mcp, 'MCP Registry URL differs from release manifest');
assert(listing.supportUrl === manifest.urls.support, 'listing support URL is not canonical');
assert(listing.securityUrl === manifest.urls.security, 'listing security URL is not canonical');
assert(listing.privacyPolicyUrl === manifest.urls.privacy, 'listing privacy URL is not canonical');
assert(listing.termsOfServiceUrl === manifest.urls.terms, 'listing terms URL is not canonical');
assert(Array.isArray(listing.screenshots) && listing.screenshots.length === 0, 'listing must not invent screenshots');
assertReleaseAuthor(listing, 'listing');
assertReleaseAuthor(manifest, 'release manifest');

const evals = await json('evals/triggers.json');
assert(evals.skills.length === skillDefinitions.length, 'trigger eval coverage differs from focused skills');
for (const evaluation of evals.skills) {
  assert(evaluation.positive.length >= 2 && evaluation.negative.length >= 2, `${evaluation.name} lacks positive or negative trigger cases`);
  assert(!evaluation.positive.some((item) => evaluation.negative.includes(item)), `${evaluation.name} trigger cases overlap`);
}

for (const [channel, source] of [['openai', 'openai'], ['claude', 'claude'], ['cursor', 'cursor'], ['gemini', 'gemini'], ['openclaw', 'openclaw'], ['mcp-registry', 'mcp-registry'], ['skill-url', 'skill-url']]) {
  const instructions = await readFile(resolve(root, `adapters/${channel}/CHANNEL.md`), 'utf8');
  assert(instructions.includes(`--distribution-source ${source} --runtime node`), `${channel} adapter source is not exact`);
}

assert(JSON.stringify(manifest.telemetry.allowlists) === JSON.stringify(telemetryAllowlists), 'telemetry allowlists differ from the supported contract');
assert(JSON.stringify(manifest.telemetry.dimensions) === JSON.stringify([
  'event', 'layer', 'protocol', 'outcome', 'visibility', 'source', 'runtime', 'clientVersion', 'errorCode', 'stage',
]), 'telemetry dimensions do not match the shared schema');
for (const field of ['agentId', 'entryId', 'keyId', 'publicKey', 'displayName', 'entryText', 'rawUrl', 'ipAddress', 'userAgent']) {
  assert(manifest.telemetry.prohibited.includes(field), `telemetry prohibition is missing ${field}`);
}

const textExtensions = new Set(['.json', '.md', '.mjs', '.svg', '.txt', '.yaml', '.yml']);
const prohibitedProduct = ['co', 'dex'].join('');
const unresolved = [['RE', 'PLACE_'].join(''), ['TO', 'DO'].join(''), ['T', 'BD'].join('')];
const files = await filesBelow(root);
for (const file of files) {
  const name = relative(root, file);
  assert(!name.toLowerCase().includes(prohibitedProduct), `prohibited product-specific filename: ${name}`);
  if (!textExtensions.has(extname(file).toLowerCase())) continue;
  const source = await readFile(file, 'utf8');
  assert(!source.includes('\u2014'), `${name} contains an em dash`);
  assert(!source.toLowerCase().includes(prohibitedProduct), `${name} contains prohibited product-specific text`);
  assert(!unresolved.some((fragment) => source.includes(fragment)), `${name} contains an unresolved placeholder`);
}
const validationProbe = process.env.INNERLOOP_VALIDATOR_PROBE;
if (validationProbe !== undefined) {
  assert(!validationProbe.toLowerCase().includes(prohibitedProduct), 'validation probe contains prohibited product-specific text');
  assert(!validationProbe.includes('\u2014'), 'validation probe contains an em dash');
  assert(!unresolved.some((fragment) => validationProbe.includes(fragment)), 'validation probe contains an unresolved placeholder');
}

console.log(`validated ${manifest.skills.length} skills, ${manifest.clients.length} clients, ${manifest.assets.length} assets, and ${files.length} package files`);
