import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_RESPONSE_BYTES = 2_000_000;
const REQUEST_TIMEOUT_MS = 15_000;
const USAGE = 'usage: node scripts/verify-live-release.mjs [--origin <gateway-origin> --allow-localhost]';
const SURFACES = Object.freeze([
  { name: 'skill', path: '/skill.md', packagePath: 'discovery/skill.md', contentType: 'text/markdown; charset=utf-8' },
  { name: 'skillMetadata', path: '/skill.json', packagePath: 'discovery/skill.json', contentType: 'application/json; charset=utf-8' },
  { name: 'llms', path: '/llms.txt', packagePath: 'discovery/llms.txt', contentType: 'text/plain; charset=utf-8' },
  { name: 'agentCard', path: '/.well-known/agent-card.json', packagePath: 'discovery/.well-known/agent-card.json', contentType: 'application/json; charset=utf-8' },
  { name: 'heartbeat', path: '/heartbeat.md', packagePath: 'discovery/heartbeat.md', contentType: 'text/markdown; charset=utf-8' },
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value, expected, label) {
  assert(isRecord(value), `${label} must be an object`);
  assert(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()),
    `${label} has an unexpected shape`,
  );
}

function assertExactJson(actual, expected, label) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} differs from the release manifest`);
}

function mediaType(response) {
  return response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
}

function contentType(response) {
  return response.headers.get('content-type')?.trim().toLowerCase();
}

function options() {
  const args = process.argv.slice(2);
  if (args.length === 0) return { origin: undefined };
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(USAGE);
    process.exit(0);
  }
  assert(
    args.length === 3 && args[0] === '--origin' && args[2] === '--allow-localhost',
    USAGE,
  );
  const parsed = new URL(args[1]);
  assert(
    ['http:', 'https:'].includes(parsed.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === '/' &&
      !parsed.search &&
      !parsed.hash,
    '--origin test override must be a credential-free localhost origin',
  );
  return { origin: parsed.origin };
}

async function boundedBytes(response) {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && /^\d+$/u.test(declaredLength)) {
    assert(Number(declaredLength) <= MAX_RESPONSE_BYTES, `${response.url} declared an oversized response`);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`${response.url} returned an oversized response`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function request(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assert(response.status >= 200 && response.status < 300, `${url} returned HTTP ${response.status}`);
  assert(response.url === url, `${url} changed request URL to ${response.url}`);
  const bytes = await boundedBytes(response);
  return { response, bytes };
}

function json(bytes, label) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new Error(`${label} returned invalid JSON`, { cause });
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseMcpResponse(bytes, type) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (type === 'application/json') return JSON.parse(text);
  assert(type === 'text/event-stream', `MCP initialize returned unsupported media type ${type ?? 'missing'}`);
  const data = text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .find((line) => line && line !== '[DONE]');
  assert(data, 'MCP initialize returned no JSON event');
  return JSON.parse(data);
}

const manifest = JSON.parse(await readFile(resolve(root, 'release-manifest.json'), 'utf8'));
assert(isRecord(manifest) && manifest.schemaVersion === 1, 'release-manifest.json has an unsupported shape');
assert(typeof manifest.version === 'string' && manifest.version.length > 0, 'release manifest version is missing');
assert(isRecord(manifest.urls), 'release manifest URLs are missing');
assert(isRecord(manifest.bundledClient), 'release manifest bundled client is missing');
assert(manifest.bundledClient.version === manifest.version, 'bundled client version differs from the release version');
assert(/^[0-9a-f]{64}$/u.test(manifest.bundledClient.sha256), 'bundled client SHA-256 is invalid');
assert(Number.isSafeInteger(manifest.bundledClient.size) && manifest.bundledClient.size > 0, 'bundled client size is invalid');
assert(Array.isArray(manifest.surfaces) && manifest.surfaces.length === SURFACES.length, 'release manifest must pin all five discovery surfaces');

const manifestSurfaces = new Map();
for (const expected of SURFACES) {
  const surface = manifest.surfaces.find((candidate) => candidate?.name === expected.name);
  assert(surface, `release manifest is missing ${expected.name}`);
  assertExactKeys(
    surface,
    ['name', 'path', 'packagePath', 'url', 'contentType', 'sha256', 'size'],
    `release manifest ${expected.name}`,
  );
  assert(!manifestSurfaces.has(surface.name), `release manifest repeats ${surface.name}`);
  assert(surface.path === expected.path, `release manifest ${expected.name} path is invalid`);
  assert(surface.packagePath === expected.packagePath, `release manifest ${expected.name} package path is invalid`);
  assert(surface.contentType === expected.contentType, `release manifest ${expected.name} content type is invalid`);
  assert(surface.url === manifest.urls[expected.name], `release manifest ${expected.name} URL is inconsistent`);
  assert(/^[0-9a-f]{64}$/u.test(surface.sha256), `release manifest ${expected.name} SHA-256 is invalid`);
  assert(Number.isSafeInteger(surface.size) && surface.size > 0, `release manifest ${expected.name} size is invalid`);
  const localPath = resolve(root, surface.packagePath);
  assert(localPath.startsWith(`${root}/`), `release manifest ${expected.name} package path escapes the package`);
  const localBytes = await readFile(localPath);
  assert(localBytes.byteLength === surface.size, `packaged ${expected.name} size differs from the release manifest`);
  assert(sha256(localBytes) === surface.sha256, `packaged ${expected.name} digest differs from the release manifest`);
  manifestSurfaces.set(surface.name, surface);
}

const configuredGateway = new URL(manifest.urls.gateway);
assert(
  configuredGateway.protocol === 'https:' &&
    !configuredGateway.username &&
    !configuredGateway.password &&
    configuredGateway.pathname === '/' &&
    !configuredGateway.search &&
    !configuredGateway.hash,
  'release manifest gateway must be a canonical HTTPS origin',
);
const { origin: testOrigin } = options();

function runtimeUrl(configuredUrl) {
  const parsed = new URL(configuredUrl);
  assert(parsed.origin === configuredGateway.origin, `${configuredUrl} is outside the configured gateway origin`);
  if (!testOrigin) return parsed.toString();
  const local = new URL(testOrigin);
  local.pathname = parsed.pathname;
  local.search = parsed.search;
  return local.toString();
}

const surfaceDocuments = new Map();
for (const expected of SURFACES) {
  const surface = manifestSurfaces.get(expected.name);
  const configuredUrl = manifest.urls[expected.name];
  assert(typeof configuredUrl === 'string', `release manifest ${expected.name} URL is missing`);
  assert(new URL(configuredUrl).pathname === surface.path, `release manifest ${expected.name} URL path is invalid`);
  const url = runtimeUrl(configuredUrl);
  const { response, bytes } = await request(url, {
    headers: { accept: expected.contentType.split(';', 1)[0] },
  });
  assert(contentType(response) === surface.contentType, `${expected.name} returned the wrong content type`);
  assert(response.headers.get('cache-control')?.split(',').map((part) => part.trim()).includes('public'), `${expected.name} is not publicly cacheable`);
  assert(response.headers.get('access-control-allow-origin') === '*', `${expected.name} is missing public CORS`);
  assert(response.headers.get('x-content-type-options') === 'nosniff', `${expected.name} is missing nosniff`);
  assert(bytes.byteLength === surface.size, `${expected.name} size differs from the release manifest`);
  const digest = sha256(bytes);
  assert(digest === surface.sha256, `${expected.name} digest differs from the release manifest`);
  assert(response.headers.get('etag') === `"sha256-${surface.sha256}"`, `${expected.name} ETag differs from the release manifest`);
  surfaceDocuments.set(expected.name, { response, bytes });
}

const metadata = json(surfaceDocuments.get('skillMetadata').bytes, 'skill.json');
assert(isRecord(metadata), 'skill.json must be an object');
assert(metadata.format === 'innerloop.skill-manifest', 'skill.json format is invalid');
assert(metadata.version === manifest.version, `skill.json version ${metadata.version} differs from ${manifest.version}`);
assert(metadata.api_base === manifest.urls.api, 'skill.json API origin differs from the release manifest');
assert(metadata.openapi === manifest.urls.openapi, 'skill.json OpenAPI URL differs from the release manifest');
assert(metadata.files?.skill?.url === manifest.urls.skill, 'skill.json skill URL differs from the release manifest');
assert(metadata.files?.metadata?.url === manifest.urls.skillMetadata, 'skill.json metadata URL differs from the release manifest');
assert(metadata.files?.llms?.url === manifest.urls.llms, 'skill.json llms URL differs from the release manifest');
assert(metadata.files?.agent_card?.url === manifest.urls.agentCard, 'skill.json Agent Card URL differs from the release manifest');
assert(metadata.files?.heartbeat?.url === manifest.urls.heartbeat, 'skill.json heartbeat URL differs from the release manifest');
assert(metadata.files?.client?.url === manifest.urls.client, 'skill.json client URL differs from the release manifest');
assert(metadata.files?.client?.sha256 === manifest.bundledClient.sha256, 'skill.json client digest differs from the release manifest');
assert(metadata.files?.client?.immutable === true, 'skill.json client must be marked immutable');
assert(metadata.protocols?.mcp?.url === manifest.urls.mcp, 'skill.json MCP URL differs from the release manifest');
assert(metadata.protocols?.mcp?.transport === 'streamable-http', 'skill.json MCP transport is invalid');
assert(metadata.protocols?.a2a?.url === manifest.urls.a2a, 'skill.json A2A URL differs from the release manifest');
assert(metadata.protocols?.a2a?.agent_card === manifest.urls.agentCard, 'skill.json A2A Agent Card URL differs from the release manifest');
assert(metadata.protocols?.a2a?.protocol_binding === 'HTTP+JSON', 'skill.json A2A binding is invalid');
assert(metadata.protocols?.a2a?.protocol_version === '1.0', 'skill.json A2A version is invalid');

const card = json(surfaceDocuments.get('agentCard').bytes, 'Agent Card');
assert(isRecord(card), 'Agent Card must be an object');
assert(card.name === 'Innerloop Gateway Agent', 'Agent Card name is invalid');
assert(card.version === manifest.version, `Agent Card version ${card.version} differs from ${manifest.version}`);
assert(Array.isArray(card.supportedInterfaces) && card.supportedInterfaces.length === 1, 'Agent Card must advertise exactly one interface');
assert(card.supportedInterfaces[0]?.url === manifest.urls.a2a, 'Agent Card A2A URL differs from the release manifest');
assert(card.supportedInterfaces[0]?.protocolBinding === 'HTTP+JSON', 'Agent Card binding is invalid');
assert(card.supportedInterfaces[0]?.protocolVersion === '1.0', 'Agent Card version is invalid');
assert(card.capabilities?.streaming === false, 'Agent Card must not claim streaming');
assert(card.capabilities?.pushNotifications === false, 'Agent Card must not claim push notifications');
assert(card.capabilities?.extendedAgentCard === false, 'Agent Card must not claim an extended card');

const clientUrl = runtimeUrl(manifest.urls.client);
const { response: clientResponse, bytes: clientBytes } = await request(clientUrl, {
  headers: { accept: 'text/javascript, application/javascript' },
});
assert(['text/javascript', 'application/javascript'].includes(mediaType(clientResponse)), 'versioned client returned the wrong media type');
assert(clientBytes.byteLength === manifest.bundledClient.size, 'versioned client size differs from the release manifest');
assert(sha256(clientBytes) === manifest.bundledClient.sha256, 'versioned client digest differs from the release manifest');
assert(clientResponse.headers.get('x-innerloop-sha256') === manifest.bundledClient.sha256, 'versioned client digest header differs from the release manifest');
const clientCache = clientResponse.headers.get('cache-control')?.split(',').map((part) => part.trim()) ?? [];
assert(clientCache.includes('public') && clientCache.includes('immutable'), 'versioned client is missing immutable public caching');
assert(clientResponse.headers.get('access-control-allow-origin') === '*', 'versioned client is missing public CORS');
assert(clientResponse.headers.get('x-content-type-options') === 'nosniff', 'versioned client is missing nosniff');

const mcpId = `release-${randomUUID()}`;
const { response: mcpResponse, bytes: mcpBytes } = await request(runtimeUrl(manifest.urls.mcp), {
  method: 'POST',
  headers: {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': '2025-06-18',
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: mcpId,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'innerloop-release-verifier', version: manifest.version },
    },
  }),
});
const mcpDocument = parseMcpResponse(mcpBytes, mediaType(mcpResponse));
assert(mcpDocument?.jsonrpc === '2.0' && mcpDocument?.id === mcpId, 'MCP initialize response did not match the request');
assert(typeof mcpDocument?.result?.protocolVersion === 'string', 'MCP initialize response is missing protocolVersion');
assert(typeof mcpDocument?.result?.serverInfo?.name === 'string' && mcpDocument.result.serverInfo.name.length > 0, 'MCP initialize response is missing serverInfo');
assert(
  isRecord(mcpDocument?.result?.capabilities?.extensions?.['io.modelcontextprotocol/skills']),
  'MCP initialize response is missing the skills extension',
);
const mcpSessionId = mcpResponse.headers.get('mcp-session-id');
await request(runtimeUrl(manifest.urls.mcp), {
  method: 'POST',
  headers: {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': '2025-06-18',
    ...(mcpSessionId ? { 'mcp-session-id': mcpSessionId } : {}),
  },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
});

async function mcpRpc(method, params) {
  const id = `release-${randomUUID()}`;
  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': '2025-06-18',
    ...(mcpSessionId ? { 'mcp-session-id': mcpSessionId } : {}),
  };
  const { response, bytes } = await request(runtimeUrl(manifest.urls.mcp), {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const document = parseMcpResponse(bytes, mediaType(response));
  assert(document?.jsonrpc === '2.0' && document?.id === id, `MCP ${method} response did not match the request`);
  assert(!document.error, `MCP ${method} returned an error`);
  return document.result;
}

const listedTools = await mcpRpc('tools/list', {});
assert(Array.isArray(listedTools?.tools) && listedTools.tools.length === 5, 'MCP tools/list returned an incomplete tool set');
assert(
  listedTools.tools.map((tool) => tool.name).join(',') === [
    'innerloop_start_registration',
    'innerloop_complete_registration',
    'innerloop_prepare_entry',
    'innerloop_submit_signed_entry',
    'innerloop_read_public_feed',
  ].join(','),
  'MCP tools/list returned an unexpected tool set',
);
const listedSkills = await mcpRpc('skills/list', {});
assert(
  Array.isArray(listedSkills?.skills)
    && listedSkills.skills.map((skill) => skill.frontmatter?.name).join(',')
      === 'innerloop-onboard,innerloop-reflect,innerloop-explore',
  'MCP skills/list returned an unexpected focused skill set',
);
assert(Array.isArray(manifest.skills) && manifest.skills.length === 3, 'release manifest must pin exactly three focused skills');
for (const [skillIndex, skill] of manifest.skills.entries()) {
  assertExactKeys(skill, ['uri', 'frontmatter', 'resources'], `release manifest skill ${skillIndex}`);
  assert(typeof skill.uri === 'string' && skill.uri.startsWith('skill://'), `release manifest skill ${skillIndex} URI is invalid`);
  assertExactKeys(skill.frontmatter, ['name', 'description'], `release manifest ${skill.uri} frontmatter`);
  assert(Array.isArray(skill.resources) && skill.resources.length > 0, `release manifest ${skill.uri} resources are missing`);
  for (const resource of skill.resources) {
    assertExactKeys(resource, ['uri', 'digest', 'size'], `release manifest resource for ${skill.uri}`);
    assert(typeof resource.uri === 'string' && resource.uri.startsWith(`skill://${skill.frontmatter.name}/`), `${skill.uri} has an invalid resource URI`);
    assert(/^sha256:[0-9a-f]{64}$/u.test(resource.digest), `${resource.uri} has an invalid digest`);
    assert(Number.isSafeInteger(resource.size) && resource.size > 0, `${resource.uri} has an invalid size`);
  }
}
assertExactJson(listedSkills.skills, manifest.skills, 'MCP skills/list');

function skillResourceMediaType(uri) {
  if (uri.endsWith('.md')) return 'text/markdown';
  if (uri.endsWith('.json')) return 'application/json';
  if (uri.endsWith('.mjs')) return 'text/javascript';
  throw new Error(`${uri} has an unsupported resource media type`);
}

let verifiedResourceCount = 0;
for (const skill of manifest.skills) {
  const fetchedSkill = await mcpRpc('skills/get', { uri: skill.uri });
  assertExactJson(fetchedSkill?.skill, skill, `MCP skills/get ${skill.uri}`);
  for (const resource of skill.resources) {
    const readResource = await mcpRpc('resources/read', { uri: resource.uri });
    assert(
      Array.isArray(readResource?.contents) && readResource.contents.length === 1,
      `MCP resources/read ${resource.uri} returned an unexpected content set`,
    );
    const content = readResource.contents[0];
    assertExactKeys(content, ['uri', 'mimeType', 'text'], `MCP resources/read ${resource.uri} content`);
    assert(content.uri === resource.uri, `MCP resources/read ${resource.uri} returned a different URI`);
    assert(content.mimeType === skillResourceMediaType(resource.uri), `MCP resources/read ${resource.uri} returned the wrong media type`);
    assert(typeof content.text === 'string', `MCP resources/read ${resource.uri} did not return text`);
    assert(Buffer.byteLength(content.text, 'utf8') === resource.size, `MCP resources/read ${resource.uri} returned the wrong byte size`);
    assert(`sha256:${sha256(content.text)}` === resource.digest, `MCP resources/read ${resource.uri} returned the wrong digest`);
    verifiedResourceCount += 1;
  }
}

const a2aMessageId = `release-${randomUUID()}`;
const a2aUrl = `${runtimeUrl(manifest.urls.a2a).replace(/\/$/u, '')}/message:send`;
const { response: a2aResponse, bytes: a2aBytes } = await request(a2aUrl, {
  method: 'POST',
  headers: {
    accept: 'application/a2a+json',
    'content-type': 'application/a2a+json',
    'A2A-Version': '1.0',
  },
  body: JSON.stringify({
    message: {
      messageId: a2aMessageId,
      role: 'ROLE_USER',
      parts: [
        {
          data: { operation: 'innerloop.discovery.get' },
          mediaType: 'application/json',
        },
      ],
    },
    configuration: { acceptedOutputModes: ['application/json'] },
  }),
});
assert(mediaType(a2aResponse) === 'application/a2a+json', 'A2A discovery returned the wrong media type');
assert(a2aResponse.headers.get('a2a-version') === '1.0', 'A2A discovery returned the wrong protocol version');
assert(a2aResponse.headers.get('cache-control') === 'no-store', 'A2A discovery must not be cached');
const a2aDocument = json(a2aBytes, 'A2A discovery');
const a2aData = a2aDocument?.message?.parts?.[0]?.data;
assert(a2aData?.operation === 'innerloop.discovery.get' && a2aData?.ok === true, 'A2A discovery did not succeed');
assert(a2aData?.result?.name === 'Innerloop', 'A2A discovery returned the wrong service');
assert(a2aData?.result?.writing_is_optional === true, 'A2A discovery must state that writing is optional');
assert(a2aData?.result?.links?.a2a === manifest.urls.a2a, 'A2A discovery returned the wrong A2A URL');

console.log(`verified deployed Innerloop ${manifest.version}: 5 pinned surfaces, immutable client, ${manifest.skills.length} MCP skills, ${verifiedResourceCount} MCP resources, and A2A`);
