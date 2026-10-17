# Current Coke tool contract

Source of executable behavior: `src/agent-loop.mjs`, `src/tools-cli.mjs`, `src/browser-server.mjs`, `bin/coke.mjs`. Reinspect these files when changing tools; do not use upstream command syntax against Coke.

## Model decisions

| Decision | Required fields | Behavior |
| --- | --- | --- |
| `click-ref` | `ref` | Click a current interactive reference |
| `fill-ref` | `ref`, `value` | Replace a current textbox value; no secret filling |
| `wait` | `milliseconds` | Integer 100–2000; consumes a step, shared maximum ten waits |
| `answer` | `value` | Finish with an exact substring of the latest observed text |
| `answer-report` | `path`, `excerpts:[{step}]` (optional exact `quote`) | Select 1–100 supplied observations or verify explicit excerpts; host writes and reads back a report of at most 64 KiB |
| `workspace-write` | `path`, `value`, `idempotencyKey` | Write a task-relative UTF8 file, at most 64 KiB |
| `workspace-read` | `path` | Read a task-relative UTF8 file |

The model does not have arbitrary shell, JavaScript evaluation, direct website API, scroll, tabs, keypress, upload/download, screenshot selection or browser provisioning decisions. The host performs read/navigate/screenshot/acquire/release. A download link for an exported task artifact is supported; general website file downloads are not.

## Operator launch

From the repository directory, with private environment already configured:

```bash
node bin/coke.mjs task run 'Read the authorized page heading' \
  --runtime local --url https://example.com --model glm-5.3
```

Use `--runtime e2b` for a real sandbox. Defaults: six decisions and 90 seconds; configurable maximum twenty decisions and 120 seconds. Online jobs use twenty/120 seconds. Do not print `.env.local`, operator tokens, encrypted state or Vault values.

Online tasks are submitted through the authenticated application/API with task, URL and optional profile. The server maps the caller to a user, grants one capacity slot and registers a task capability. `COKE_BROWSER_GATEWAY_URL` requires trusted parent IPC registration: a standalone CLI process with that setting cannot register itself. Do not unset it in production to get around a gateway error. For isolated local development the established bridge works without the setting.

Low-level E2B browser invocation uses the template's `node /opt/coke/tools-cli.mjs browser <action>` with task-bound environment supplied by the coordinator. The gateway token and task binding are runtime inputs, not secrets to discover or manufacture in a skill. The gateway only accepts the already acquired lease; it does not expose Vault operations or acquire/release to E2B.

## Failures and limits

- Host automatically reads each turn; refs are rebuilt on every read. Text is capped at 12,000 characters; interactive elements are bounded to 100.
- Host can correct two invalid pre-execution decisions; no blind replay after browser/workspace effects.
- Gateway accepts one request in flight and rejects duplicate request IDs. Uncertain upstream failure revokes the capability. Aborting an HTTP call does not prove the browser action was undone.
- Cancellation and worker exit revoke access; cleanup releases the lease and destroys the sandbox. Persistent task records exist; checkpoint resume does not.
- The model loop has no terminal blocked/approval action. Do not fabricate that JSON contract. Operator/coordinator intervention is needed for login challenges or approval-required work; this skill alone does not implement that intervention.
- A click action is not inherently read-only. Online mode blocks non-GET/HEAD browser requests, but that filter is not a complete semantic guarantee against every site's mutations. Keep read-only task intent in the policy and verify page effects.
