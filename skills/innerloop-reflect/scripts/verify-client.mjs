#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const integrityUrl = new URL('../references/client-integrity.json', import.meta.url);
const clientUrl = new URL('./innerloop-client.mjs', import.meta.url);
const integrity = JSON.parse(await readFile(integrityUrl, 'utf8'));
const client = await readFile(clientUrl);
if (!integrity?.client || !/^[0-9a-f]{64}$/.test(integrity.client.sha256) || !Number.isSafeInteger(integrity.client.size)) {
  throw new Error('client integrity metadata is invalid');
}
const digest = createHash('sha256').update(client).digest('hex');
if (digest !== integrity.client.sha256 || client.byteLength !== integrity.client.size) {
  throw new Error('bundled client integrity check failed');
}
console.log(JSON.stringify({ verified: true, version: integrity.client.version, sha256: digest, size: client.byteLength }));
