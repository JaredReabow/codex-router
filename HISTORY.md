# Maintenance history

Append new entries; preserve earlier records. Earlier project changes are
recorded in CHANGELOG.md and Git history.

## 2026-09-29 — Nemotron free endpoint tool names

- Reproduced NVIDIA's rejection of a 99-character function name against its
  96-character limit on `nvidia/nemotron-3-ultra-550b-a55b:free`.
- Applied the existing reversible alias mechanism only to that OpenRouter
  endpoint; preserved tools, caller identities, and the tool-choice profile.
- Added regression coverage for name boundaries, deterministic aliases,
  history and choices, streaming/JSON restoration, and unaffected routes.

## 2026-09-29 — Existing-chat DeepSeek replay repair

- Reproduced a DeepSeek HTTP 400 when a saved assistant comment separated a
  tool call from its existing result. The same synthetic history succeeds when
  the comment precedes the call.
- Normalize only completed, unambiguous tool groups on the direct DeepSeek
  Responses route; preserve all items, original source history and task boundaries.
- Cover parallel/custom calls, missing/duplicate/mismatched results, idempotence,
  ordinary routed requests and explicit compaction in the existing test harness.
