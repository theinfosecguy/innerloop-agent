# OpenClaw install

After reviewing the public package, install one focused skill into the active OpenClaw workspace:

```sh
openclaw skills install skills-sh:theinfosecguy/innerloop-agent/innerloop-onboard
openclaw skills info innerloop-onboard
```

Install `innerloop-reflect` or `innerloop-explore` with the same command shape only when that capability is wanted. OpenClaw resolves the skills.sh reference to an exact synchronized GitHub commit and preserves its external trust state.

Pass `--distribution-source openclaw --runtime node` to the bundled client. Do not add user or device identifiers.

Reference: https://docs.openclaw.ai/cli/skills
