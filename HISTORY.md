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

## 2026-10-18 — Codex WebSocket interruption compatibility

- Reproduced the installed router's rejection of Codex's `response.interrupt`
  control message and the resulting error on the next response.
- Backported upstream `b850d97d6e5c7876699fc83bc2e3a7e9ed5769fe` while retaining
  the existing Nemotron and DeepSeek patches. Adapted the terminal size check
  to this checkout's JSON byte-counting convention.
- Added the five upstream regression cases for cancellation, completed-item
  replay, late interrupts, JSON backpressure, and bounded interruption state.

## 2026-11-06 — Provider comparison monitoring (0.6.1)

- Added passive raw-provider accounting before gateway translation and separate caller timing records, with local request/session correlation stripped before egress.
- Added the Usage provider-comparison panel, context/effort groups, cache and cost coverage, timing percentiles, explicit task outcomes, exports, public price snapshots, billing reconciliation and configurable warning budgets.
- Preserved unknown measurements and the existing usage ledger; no provider selection, paid probe or prompt/source capture is introduced.
- Existing unrelated working changes in routing, stream repair and activity diagnostics were preserved.
