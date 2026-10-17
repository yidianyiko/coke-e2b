# Sources and adaptations

Researched 2026-10-17. GitHub page counts are approximate and change; GitHub metadata API returned a rate-limit403, so no exact star count is claimed.

## Primary: vercel-labs/agent-browser

- Repository: https://github.com/vercel-labs/agent-browser (GitHub page: about44.1k stars).
- Pinned revision: `dac13bb87468fe9d74a040d862720f6cc17a9565`.
- Actual core skill: https://github.com/vercel-labs/agent-browser/blob/dac13bb87468fe9d74a040d862720f6cc17a9565/skill-data/core/SKILL.md
- Reference lifecycle: https://github.com/vercel-labs/agent-browser/blob/dac13bb87468fe9d74a040d862720f6cc17a9565/skill-data/core/references/snapshot-refs.md
- Trust boundaries: https://github.com/vercel-labs/agent-browser/blob/dac13bb87468fe9d74a040d862720f6cc17a9565/skill-data/core/references/trust-boundaries.md
- License: Apache-2.0, Copyright2025 Vercel Inc.; full notice in [licenses/agent-browser-Apache-2.0.txt](licenses/agent-browser-Apache-2.0.txt). No upstream NOTICE file was present at this revision.

The installed-discovery `skills/agent-browser/SKILL.md` is only a stub; the workflow was read from `skill-data/core`, not inferred from that stub.

## Secondary: browser-use/browser-use

- Repository: https://github.com/browser-use/browser-use (GitHub page: about118k stars).
- Pinned revision: `ccd22fef47a1a36e0c4596fef5db73a5117b9d06`.
- Skill: https://github.com/browser-use/browser-use/blob/ccd22fef47a1a36e0c4596fef5db73a5117b9d06/skills/browser-use/SKILL.md
- License: MIT, Copyright(c)2024 Gregor Zunic; full notice in [licenses/browser-use-MIT.txt](licenses/browser-use-MIT.txt).

## What was retained or changed

This is an adapted, independently worded Coke workflow, not an upstream CLI installation or an unchanged upstream skill. Upstream licenses are retained for the reference-derived guidance. No upstream executable code or templates were incorporated.

| Upstream practice | Coke adaptation |
| --- | --- |
| Snapshot, choose semantic target, act, observe again | Use current `read.elements` refs and verify the next observation |
| Refresh after navigation or dynamic updates | Stricter: every Coke read invalidates old refs; upstream surviving-ref reuse is not imported |
| Isolate parallel browser work and reuse the intended session | Host-bound user/task lease; no shared local daemon or newly invented session/profile |
| Use text/structured accessibility data before visual guessing | Model receives bounded text/elements; screenshots remain host evidence, not model vision input |
| Wait for page readiness and diagnose missing elements | Bounded wait and pre-execution correction; no missing tools or unbounded retries |
| Page content is untrusted; approval is external to the page | Preserve task authorization, Vault-only secrets and current read-only scope |
| Verify outputs after interaction | Exact observation quotes plus host file write/read-back; incomplete coverage is explicit |
| Optional domain skills | Small vetted TickTick reference; no fabricated selectors, saved refs or success claims |

Not imported: upstream package installation, paid cloud registration, local desktop CDP attachment, cross-task shared daemon conventions, raw JavaScript/CDP fallback, automatic consent/dialog acceptance, WebMCP tools, anti-bot workarounds, scroll/tabs/upload commands absent from Coke, or upstream promotional actions.

Tencent/BrowserSkill was also checked as a candidate. Its existing-browser/extension integration was not selected as the basis for this E2B/cloud-lease runtime; no content from it was incorporated.
