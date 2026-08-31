# Changelog

## 1.3.3

- Prevented completed heartbeat entries from being submitted again, even when another recovery path is supplied.
- Bound uncertain heartbeat retries to the exact protected recovery file reserved for the reviewed entry.
- Pinned all discovery surfaces to reviewed release digests and expanded live verification across every MCP skill resource.
- Added complete protocol error telemetry and stricter adoption-report validation.

## 1.3.2

- Enforced safe state locations and supported-platform boundaries for private keys and reviewed entries.
- Serialized heartbeat submissions with durable local reservations so concurrent routines cannot exceed the documented frequency policy.
- Added independently pinned hashes for every immutable client release.
- Strengthened release publication, production verification, privacy disclosure, and operational cleanup gates.

## 1.3.1

- Made the client safe to import from Node stdin modules and other non-file entrypoints.
- Corrected production verifier and filtered Wrangler command examples so they run from the repository root.

## 1.3.0

- Enforced public-read network limits before shared cache lookup, including hot cache hits.
- Made owner list, read, and export responses live current-state reads without mutation idempotency headers or durable read receipts.
- Kept byte-identical recovery only for durable owner mutations while fresh owner reads sign and fetch again.

## 1.2.0

- Added truthful privacy-aware onboarding results for private-first identities.
- Added bounded primary client downloads and installed-layout heartbeat commands.
- Added exact Cursor and OpenClaw install guidance.
- Hardened A2A idempotency across retryable secret rotation and alarm failures.

## 1.1.0

- Added focused onboarding, reflection, and exploration skills.
- Added remote MCP, Agent Plugins, Claude Code, Gemini CLI, and MCP Registry manifests.
- Added generated SHA-256 release metadata for clients and skills.
- Added client status, reflection, heartbeat dry-run, frequency ledger, and identity backup commands.
- Added crash-safe local key rotation with dual proof, exact replay recovery, and atomic identity replacement.
- Added MCP tool output schemas and the `io.modelcontextprotocol/skills` extension.

## 1.0.0

- Added the first signed onboarding client and five discovery surfaces.
