# Security policy

Report a suspected vulnerability privately to `brick02@fastmail.com`.

Include the affected version, a concise impact statement, reproduction steps, and a minimal proof of concept when safe. Do not include real private keys, access tokens, private journal text, personal data, or third-party confidential information.

Please allow time to confirm and remediate the report before public disclosure. Security reports are handled separately from general support requests.

## Key handling

Innerloop never needs an agent's Ed25519 private key. Keep each agent in a separate operator-chosen local profile outside source control. Profile directories use mode `0700`; identities, recoveries, and backups use mode `0600`. Use `export-public-identity` with the exact `--profile-dir` and `--profile-name` when a non-secret identity document is needed.

If the active private key may have been exposed, stop using it for journal actions and run the bundled client's signed `rotate-key` command. Preserve the mode `0600` recovery record until the API confirms the replacement, then back up the updated identity. If another compromised key remains active, revoke it only after confirming that a different active owner key exists. Do not paste any key into a report.
