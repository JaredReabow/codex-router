# Comparing inference providers

Version 0.6.1 adds passive metadata collection and a Provider comparison panel on
Usage. It does not select providers, change retry policy, issue benchmark prompts,
or retain prompt text, source code, tool arguments or response text.

## Measurements

The router records caller-visible request duration, first generated token,
reported tokens, retries and empty/failed responses. The API forwarder separately
observes raw provider attempts before gateway translation. That observation keeps
OpenRouter's actual provider name, generation ID, served model, reported USD cost,
cache/reasoning tokens, service tier, first generated and first visible token,
completion reason, cancellations and transport/stream failures. Correlation IDs
are carried only over the internal gateway/forwarder hop and stripped before
external transmission. Requested effort and sampling settings are recorded when
present; missing values remain unknown. A gateway can omit or rewrite fields, so
raw-provider and caller settings remain distinct evidence.

Requests and attempts are different observation points. The comparison never
adds their costs together. A provider-internal retry that OpenRouter does not
report cannot be reconstructed. A failed stream without final usage has unknown
cost, not zero. Direct DeepSeek does not normally return a USD charge per request;
its cost stays unknown until reconciled against the provider's account export.
Existing usage-events.jsonl remains unchanged and can still be used for historical
volume/caching comparisons. The new granular records start with deployment.

Route summaries include measured coverage, token-weighted cache-hit rates, median
and p95 response times, median generation speed, request errors and cancellations.
Speed excludes incomplete streams and unknown reasoning accounting. Context/effort
views reduce confounding but do not establish matched task difficulty or identical
provider tokenization. Session results are explicitly assessed, never inferred
from an HTTP 200. Tasks using multiple hosts need an acceptance assessment for the
whole task; a session total is not attribution of success to one host.

## Controls

The Usage panel offers 1/7/30/90-day windows, route/context/session views, individual
request metadata, full-window JSON/CSV export, task outcomes, public price
snapshots, generation reconciliation, fee assumptions, warning thresholds and UTC
daily/monthly budgets. CSV exports neutralize spreadsheet formula prefixes.

Example CLI commands (JSON arguments use shell single quotes):

```sh
./bin/control monitoring status '{"days":30}'
./bin/control monitoring settings '{"cacheWarningPercent":90,"errorWarningPercent":5,"minimumSamples":20}'
./bin/control monitoring settings '{"dailyBudgetUsd":25,"monthlyBudgetUsd":500}'
./bin/control monitoring settings '{"dailyBudgetUsd":null,"monthlyBudgetUsd":null}'
./bin/control monitoring outcome '{"sessionId":"SESSION_ID","outcome":"passed","testsPassed":12,"testsFailed":0}'
./bin/control monitoring prices '{"model":"deepseek/deepseek-v4.1-flash-1017"}'
./bin/control monitoring reconcile '{"limit":50}'
./bin/control monitoring export '{"days":30,"format":"csv"}'
```

CLI export returns a JSON envelope with the exported text in `content`; the UI
writes that text directly into the chosen download. All operations validate their
inputs. Unknown actions/settings are rejected. Reconciliation uses the existing
OpenRouter credential only at the fixed official generation endpoint. It appends
corrections instead of rewriting original observations. Price snapshots use a
fixed public OpenRouter endpoint with no credential. Neither operation invokes a
model. Reconciliation and public price refresh are explicit actions, not hidden
network calls during a normal refresh.

## Alerts, money and privacy

Alerts cover low cache-hit rates, high error rates, missing billing/cache coverage,
reported hosts outside the requested host list, published price changes and budget
thresholds. The cache baseline warning compares against the direct sample and
explicitly notes that task mix may differ. Alerts appear in the panel; there are
no periodic external notifications, route changes or automatic paid fallbacks.
Budgets are warnings, not hard spending caps. They include known OpenRouter
inference charges plus the configured fee estimate, regardless of a shorter
selected display window. Missing-cost attempts are shown separately. No monetary
budget is guessed: both defaults are unset. The default 5.5% OpenRouter fee is an
editable estimate, not a verified account plan, tax or payment fee.

Metadata is stored as owner-only append-only daily files beneath
`~/.codex/codex-router/request-monitoring/`. Daily shards bound reads to the chosen
window; records are retained until the operator removes them. Settings are in
`request-monitoring-settings.json` in the same state directory. Existing
MODEL_ROUTER_STATE_DIR/CODEX_HOME overrides apply to tests and other installs.
Collector heartbeat files show recent successful writes. A filesystem failure
never interrupts inference; the process logs one generic warning without payloads.
Disabling collection stops automatic recording. Explicit outcome/price actions
remain intentional writes. Session IDs are local metadata; no session titles or
filesystem paths are collected.

Use actual OpenRouter costs, cache coverage and task outcomes to decide whether a
host saves money. A cheap endpoint listing or a successful test fixture does not
establish quality or billing on a live provider.
