# Coke E2B

A browser agent runtime with E2B task sandboxes, a leased Playwright browser, scoped credentials, and verified report exports.

> Early-stage software. Chromium and model orchestration run on the host; task tools execute in E2B. General public-site reading is supported through the integration API. Credential login currently has a TickTick adapter; unsupported forms and challenges return explicit blocked states. Read-only restrictions reduce risk but cannot guarantee that every website GET or click has no side effect.

## Architecture

```text
Chat / application
       | trusted user + request identity
       v
Restricted integration API ---> durable request records
       |                          |
       v                          v
Host model loop             scoped report access
       |
E2B task CLI -- HTTPS gateway --> leased Playwright / Chromium
                                      |
                               public-only network proxy
                                      |
                                   website
```

Each task has its own E2B sandbox. Browser leases and profiles are scoped to the owning user. Vault secrets stay on the trusted host, outside model prompts and sandbox tool input.

## Quick start

Requirements: Node.js 22+, npm, and Chromium. Set `COKE_CHROMIUM_PATH` if it is not `/usr/bin/chromium-browser`.

```sh
npm ci
cp .env.example .env.local
# Fill in your own model and E2B credentials.
node --env-file=.env.local bin/coke.mjs task run 'Read the destination heading' \
  --runtime local --url https://the-internet.herokuapp.com/ \
  --link-text 'Add/Remove Elements' --value-selector h3
```

For model-driven execution, configure an OpenAI-compatible Chat Completions endpoint:

```sh
node --env-file=.env.local bin/coke.mjs task run 'Read this page and save verified excerpts to report.txt' \
  --runtime local --url https://example.com --model YOUR_MODEL_ID
```

Before using `--runtime e2b`, build the template in **your own E2B project**:

```sh
node --env-file=.env.local scripts/build-e2b-template.mjs
# Then replace --runtime local with --runtime e2b in a task command.
```

Template `coke-task-cli:v3` contains the browser and workspace tools. The runner checks their hashes before executing. Building and running E2B sandboxes can incur charges.

## Online service

1. Create a private auth JSON file containing `[{"token":"YOUR_RANDOM_TOKEN_AT_LEAST_24_CHARACTERS","userId":"operator"}]`; set permissions to0600.
2. Configure `COKE_AUTH_FILE` and a writable `COKE_DATA_DIR` in your private environment.
3. Run `node --env-file=.env.local bin/server.mjs`. Default listen address is `127.0.0.1:3210`.
4. For remote use, terminate TLS at your reverse proxy and configure `COKE_BROWSER_GATEWAY_URL=https://YOUR_HOST/v1/browser/action`. Do not expose the internal browser service directly.

The optional integration API requires a separate `COKE_INTEGRATION_TOKEN` (at least24 characters) and `COKE_PUBLIC_BASE_URL`. Treat this credential as server-only: the caller supplies a trusted canonical user ID; never expose the service token or let the model choose ownership.

```text
POST /v1/integration/tasks
  {ownerId, requestId, task, url}
GET  /v1/integration/tasks/:requestId?ownerId=...
POST /v1/integration/tasks/:requestId/cancel
  {ownerId}
```

Authenticate with `Authorization: Bearer <integration token>`. Request replay is idempotent; changing its body conflicts. Capacity waits are queued. Unknown dispatch outcomes are interrupted rather than automatically replayed. Result links are short-lived scoped capabilities; share them only with their intended owner.

Operator routes retain a TickTick allowlist. The integration API enables general public HTTP(S) targets with a DNS-pinning proxy that rejects private/reserved addresses across requests. Arbitrary authenticated website login is not guaranteed.

## Verification

```sh
npm test
node scripts/accept-integration-result.mjs
node scripts/accept-public-network.mjs
# Optional billable E2B checks:
RUN_E2B_TEST=1 node --env-file=.env.local --test test/*.test.mjs
```

Default tests use fixtures; real E2B tests are opt-in. Public-site checks depend on internet connectivity. Report content is verified against captured observations and read back after saving; coverage is limited to observed content, not guaranteed complete website enumeration.

## Data and deployment

Keep `.env.local`, `.coke-private/`, task artifacts, cookies, Vault keys and browser profiles private. Preserve the data directory when updating deployments. Revoking a profile prevents older active leases from restoring it. Never publish credentials or personal exports.

A Dockerfile is included. Mount a private writable `/data` directory owned by UID1000 and provide runtime secrets outside the image. A chat connector and its user directory are separate services; this repository provides the execution API.

## License and attribution

Original project code is MIT licensed; see [LICENSE](LICENSE). Browser skill guidance adapts workflows from agent-browser and browser-use; their attribution and original licenses are retained in [.agents/skills/browser-use/references/sources.md](.agents/skills/browser-use/references/sources.md). This is an independent project, not affiliated with E2B, Instinct, Vercel, or browser-use.
