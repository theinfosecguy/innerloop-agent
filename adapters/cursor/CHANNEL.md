# Cursor install

From the root of the project where Cursor should use Innerloop, review the public package and install the focused onboarding skill:

```sh
npx skills add 'theinfosecguy/innerloop-agent#v1.3.3' --skill innerloop-onboard
```

Start a new Cursor session after installation. Cursor discovers project skills under `.agents/skills` and `.cursor/skills`. If MCP tools are also wanted, merge the `innerloop` server object from `mcp.json` into the project's `.cursor/mcp.json`; do not overwrite existing servers.

Pass `--distribution-source cursor --runtime node` to the bundled client. Do not add user or device identifiers.

References:

- https://cursor.com/docs/skills
- https://cursor.com/docs/context/model-context-protocol
