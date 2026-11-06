import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const home = mkdtempSync(path.join(os.tmpdir(), "router-monitoring-"));
process.env.MODEL_ROUTER_STATE_DIR = home;
process.env.CODEX_HOME = home;
const m = await import("../src/request-monitoring.mjs");
test.after(() => rmSync(home, { recursive: true, force: true }));
const at = new Date().toISOString();
const ledger = path.join(home, "request-monitoring", `${at.slice(0, 10)}.jsonl`);

test("raw SSE accounting preserves every byte and captures provider cost before translation", async () => {
  const payload = { id: "gen-example", provider: "OpenInference", model: "deepseek/deepseek-v4.1-flash-1017",
    choices: [{ delta: { content: "private-source-text" } }], usage: { prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 900 }, completion_tokens: 100,
      completion_tokens_details: { reasoning_tokens: 40 }, cost: .00125 } };
  const text = `data: ${JSON.stringify(payload)}\r\n\r\ndata: [DONE]\r\n\r\n`;
  const bytes = new TextEncoder().encode(text);
  const response = await m.monitoring_fetch("https://openrouter.ai/api/v1/chat/completions", {},
    { provider: "openrouter", requestId: "req-unit", sessionId: "session-unit" }, async () => new Response(new ReadableStream({ start(c) {
      c.enqueue(bytes.slice(0, 20)); c.enqueue(bytes.slice(20)); c.close();
    } }), { headers: { "content-type": "text/event-stream" } }));
  assert.equal(await response.text(), text);
  const row = m.monitoring_records().find(r => r.requestId === "req-unit");
  assert.equal(row.costUsd, .00125); assert.equal(row.upstreamHost, "OpenInference");
  assert.equal(row.cachedInputTokens, 900); assert.equal(row.reasoningTokens, 40);
  assert.equal(row.generationId, "gen-example"); assert.equal(row.completed, true);
  assert.doesNotMatch(readFileSync(ledger, "utf8"), /private-source-text/);
  if (process.platform !== "win32") assert.equal(statSync(ledger).mode & 0o777, 0o600);
});

test("canceled streams and transport failures are recorded without a fabricated zero bill", async () => {
  const response = await m.monitoring_fetch("https://openrouter.ai/api/v1/chat/completions", {},
    { provider: "openrouter", requestId: "req-cancel" }, async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array([10])); } })));
  await response.body.cancel();
  const cancel = m.monitoring_records().find(r => r.requestId === "req-cancel");
  assert.equal(cancel.canceled, true); assert.equal(cancel.costUsd, undefined);
  await assert.rejects(m.monitoring_fetch("https://openrouter.ai/api/v1/chat/completions", {},
    { provider: "openrouter", requestId: "req-error" }, async () => { throw new Error("private error"); }));
  assert.equal(m.monitoring_records().find(r => r.requestId === "req-error").transportError, true);
  assert.doesNotMatch(readFileSync(ledger, "utf8"), /private error/);
});

test("partial final SSE lines, JSON nulls and explicit zero costs retain their meaning", async () => {
  const response = await m.monitoring_fetch("https://openrouter.ai/api/v1/responses", {}, { provider: "openrouter", requestId: "req-json" },
    async () => new Response(JSON.stringify({ id: "gen-json", usage: { input_tokens: 30, output_tokens: 2,
      input_tokens_details: { cached_tokens: null }, cost: 0 } }), { headers: { "content-type": "application/json" } }));
  await response.text();
  const row = m.monitoring_records().find(r => r.requestId === "req-json");
  assert.equal(row.costUsd, 0); assert.equal(row.cachedInputTokens, undefined);
  const sse = await m.monitoring_fetch("https://openrouter.ai/api/v1/responses", {}, { provider: "openrouter", requestId: "req-tail" },
    async () => new Response('data: {"response":{"id":"gen-tail","usage":{"input_tokens":1,"output_tokens":1,"cost":0.01}}}', { headers: { "content-type": "text/event-stream" } }));
  await sse.text(); assert.equal(m.monitoring_records().find(r => r.requestId === "req-tail").costUsd, .01);
});

test("aggregates weight caching by tokens, preserve missing coverage, and avoid request/attempt double counting", () => {
  const rows = [
    { kind: "request", requestId: "one", at, provider: "openrouter", model: "deepseek", costUsd: 999, durationMs: 500 },
    { kind: "attempt", requestId: "one", attemptId: "a", at, provider: "openrouter", upstreamHost: "OpenInference", model: "deepseek", inputTokens: 1000, cachedInputTokens: 900, outputTokens: 100, costUsd: .10, durationMs: 1000, firstTokenMs: 100, completed: true, status: 200 },
    { kind: "attempt", requestId: "two", attemptId: "b", at, provider: "openrouter", upstreamHost: "OpenInference", model: "deepseek", inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, costUsd: .20, durationMs: 2000, firstTokenMs: 300, completed: true, status: 200 },
    { kind: "attempt", requestId: "three", attemptId: "c", at, provider: "openrouter", upstreamHost: "OpenInference", model: "deepseek", status: 502, durationMs: 3000 },
  ];
  const snapshot = m.monitoring_snapshot({ rows, settings: { ...m.monitoring_settings(), minimumSamples: 2 } });
  const route = snapshot.routes[0];
  assert.equal(snapshot.requestCount, 1); assert.equal(snapshot.attemptCount, 3);
  assert.ok(Math.abs(route.costUsd - .3) < 1e-10); assert.equal(route.costCoveredRequests, 2);
  assert.ok(Math.abs(route.cacheHitPercent - 900 / 1100 * 100) < 1e-10);
  assert.equal(route.cacheCoveredRequests, 2); assert.equal(route.p95DurationMs, 3000);
  assert.equal(route.p50FirstTokenMs, 100); assert.equal(route.errors, 1);
  assert.ok(snapshot.alerts.some(a => /costs are unknown/.test(a.message)));
});

test("request settings are allowlisted and invalid budget policies are rejected", () => {
  const context = m.monitoring_context({ payload: { model: "deepseek/test", reasoning: { effort: "high" },
    input: "do not save", apiKey: "sk-private", temperature: 1, provider: { only: ["OpenInference"] } },
    requestId: "request-1", headers: { authorization: "Bearer sk-private", "thread-id": "thread-1" } });
  assert.equal(context.reasoningEffort, "high"); assert.equal(context.sessionId, "thread-1");
  assert.deepEqual(context.requestedHosts, ["OpenInference"]); assert.doesNotMatch(JSON.stringify(context), /do not save|sk-private/);
  assert.throws(() => m.monitoring_set_settings({ feePercent: -1 }));
  assert.throws(() => m.monitoring_set_settings({ dailyBudgetUsd: "100" }));
  assert.throws(() => m.monitoring_set_settings({ prompt: "private" }));
  assert.equal(m.monitoring_set_settings({ monthlyBudgetUsd: 500 }).monthlyBudgetUsd, 500);
});

test("explicit task outcomes replace prior assessments without creating HTTP task success", () => {
  m.monitoring_outcome({ sessionId: "task-1", outcome: "failed", testsFailed: 2 });
  m.monitoring_outcome({ sessionId: "task-1", outcome: "passed", testsPassed: 3 });
  const rows = [...m.monitoring_records(), { kind: "attempt", at, sessionId: "task-1", provider: "deepseek", model: "test", status: 200 }];
  const snapshot = m.monitoring_snapshot({ rows });
  assert.equal(snapshot.sessions.find(s => s.id === "task-1").outcome, "passed");
  assert.throws(() => m.monitoring_outcome({ sessionId: "task-1", outcome: "probably-good" }));
});

test("reconciliation joins a generation to its original attempt without double charging", async () => {
  const rows = [{ kind: "attempt", attemptId: "attempt-reconcile", generationId: "gen-reconcile", provider: "openrouter", at }];
  let calls = 0;
  const result = await m.monitoring_reconcile({ apiKey: "private-key", rows, fetchImpl: async (url, init) => {
    calls++; assert.equal(new URL(url).hostname, "openrouter.ai"); assert.equal(init.redirect, "error");
    return Response.json({ data: { total_cost: .25, provider_name: "OpenInference", native_tokens_prompt: 100,
      native_tokens_completion: 20, native_tokens_cached: 80 } });
  } });
  assert.equal(result.reconciled, 1); assert.equal(calls, 1);
  const correction = m.monitoring_records().find(r => r.kind === "reconciliation" && r.attemptId === "attempt-reconcile");
  const snapshot = m.monitoring_snapshot({ rows: [...rows, correction] });
  assert.equal(snapshot.routes[0].costUsd, .25); assert.equal(snapshot.attemptCount, 1);
  assert.doesNotMatch(JSON.stringify(correction), /private-key/);
});

test("public price snapshots retain price changes and exports neutralize spreadsheet formulas", async () => {
  let prompt = "0.000001";
  const fetchImpl = async () => Response.json({ data: { endpoints: [{ tag: "open-inference/fp4", quantization: "fp4", pricing: { prompt, discount: 0 }, apiKey: "private" }] } });
  await m.monitoring_refresh_prices(undefined, fetchImpl); prompt = "0.000002";
  await m.monitoring_refresh_prices(undefined, fetchImpl);
  assert.ok(m.monitoring_snapshot().alerts.some(a => /price changed/.test(a.message)));
  assert.match(m.monitoring_export([{ model: "=IMPORTDATA(private)" }], "csv"), /'=IMPORTDATA/);
  assert.throws(() => m.monitoring_records({ days: -1 }));
  appendFileSync(ledger, '{"partial":');
  assert.ok(m.monitoring_records().length > 0);
});

test("disabling collection stops writes without changing response bytes", async () => {
  m.monitoring_set_settings({ enabled: false });
  const before = statSync(ledger).size;
  const response = await m.monitoring_fetch("https://example.com", {}, {}, async () => new Response("untouched"));
  assert.equal(await response.text(), "untouched");
  assert.equal(statSync(ledger).size, before);
  m.monitoring_set_settings({ enabled: true });
});
