/** Private, passive request accounting. No prompts, credentials or response text are retained. */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { STATE_DIR } from "./paths.mjs";
import { VERSION } from "./version.mjs";

const LEDGER_DIR = path.join(STATE_DIR, "request-monitoring");
const SETTINGS = path.join(STATE_DIR, "request-monitoring-settings.json");
const DAY = 86_400_000;
const MAX_FRAME = 8 * 1024 * 1024;
const DEFAULTS = Object.freeze({ enabled: true, feePercent: 5.5, minimumSamples: 20,
  cacheWarningPercent: 90, errorWarningPercent: 5, dailyBudgetUsd: null, monthlyBudgetUsd: null });
const OUTCOMES = new Set(["passed", "failed", "needs-correction", "abandoned"]);
const finite = v => typeof v === "number" && Number.isFinite(v) && v >= 0;
const count = v => finite(v) && Number.isSafeInteger(v);
const ident = v => typeof v === "string" && v.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9_.:/ -]*$/.test(v)
  && !/(?:^sk-|bearer|secret|password|token=)/i.test(v) ? v : undefined;
const pick = (v, keys) => Object.fromEntries(keys.filter(k => v[k] !== undefined).map(k => [k, v[k]]));
const readCache = new Map();
let settingsCache = { signature: "", value: { ...DEFAULTS } };
let writeFailures = 0;
let lastHealthWrite = 0;

/** Return validated local policy; corrupt preferences never affect routing. */
export function monitoring_settings() {
  try {
    const st = statSync(SETTINGS), signature = `${st.size}:${st.mtimeMs}`;
    if (signature !== settingsCache.signature) {
      if (st.size > 16_384) throw new Error("Oversized monitoring settings");
      const raw = JSON.parse(readFileSync(SETTINGS, "utf8"));
      settingsCache = { signature, value: monitoring_validate_settings(raw) };
    }
    return { ...settingsCache.value };
  } catch { return { ...DEFAULTS }; }
}

function monitoring_validate_settings(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid monitoring settings");
  const result = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (!Object.hasOwn(DEFAULTS, k)) throw new Error(`Unknown monitoring setting: ${k}`);
    if (k === "enabled") { if (typeof v !== "boolean") throw new Error("enabled must be boolean"); }
    else if (k.endsWith("BudgetUsd") && v === null) { /* Explicitly disable a budget. */ }
    else if (!finite(v) || (k === "minimumSamples" && (!count(v) || v < 1 || v > 100_000))
      || (k.endsWith("Percent") && v > 100)) throw new Error(`Invalid monitoring setting: ${k}`);
    result[k] = v;
  }
  return result;
}

/** Change monitoring policy only. Routing, credentials and inference are never changed. */
export function monitoring_set_settings(patch) {
  const value = monitoring_validate_settings({ ...monitoring_settings(), ...patch });
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const temp = `${SETTINGS}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temp, SETTINGS);
  settingsCache.signature = "";
  return value;
}

function append(row) {
  try {
    mkdirSync(LEDGER_DIR, { recursive: true, mode: 0o700 });
    const file = path.join(LEDGER_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    appendFileSync(file, `${JSON.stringify({ schemaVersion: 1, routerVersion: VERSION,
      at: new Date().toISOString(), ...row })}\n`, { mode: 0o600 });
    readCache.delete(file);
    if (Date.now() - lastHealthWrite >= 60_000) {
      writeFileSync(path.join(LEDGER_DIR, `health-${process.pid}.json`), JSON.stringify({ pid: process.pid,
        lastWriteAt: new Date().toISOString(), writeFailures }), { mode: 0o600 });
      lastHealthWrite = Date.now();
    }
  } catch {
    writeFailures += 1;
    if (writeFailures === 1) console.error("[codex-router] monitoring metadata could not be saved; inference continues");
  } // Accounting must never interrupt a generation.
}

/** Allowlist request settings and identifiers; never serialize the request itself. */
export function monitoring_context({ headers = {}, payload = {}, requestId, provider, model } = {}) {
  const context = {};
  const fields = { requestId, provider, model, requestedModel: payload.model,
    threadId: headers["thread-id"] || headers["session-id"] || headers.session_id,
    parentThreadId: headers["x-codex-parent-thread-id"],
    sessionId: headers["x-router-monitor-session"],
    reasoningEffort: payload.reasoning?.effort || payload.reasoning_effort,
    requestedServiceTier: payload.service_tier };
  for (const [key, value] of Object.entries(fields)) if (ident(value)) context[key] = value;
  context.sessionId ||= context.parentThreadId || context.threadId;
  if (finite(payload.temperature)) context.temperature = payload.temperature;
  if (finite(payload.top_p)) context.topP = payload.top_p;
  if (count(payload.max_output_tokens ?? payload.max_tokens)) context.maxOutputTokens = payload.max_output_tokens ?? payload.max_tokens;
  const allowed = payload.provider?.only || payload.provider?.order;
  if (Array.isArray(allowed)) context.requestedHosts = allowed.slice(0, 16).map(ident).filter(Boolean);
  return context;
}

/** Add private correlation only to the internal gateway hop; the forwarder strips it. */
export function monitoring_internal_headers(requestId, context = {}) {
  return Object.fromEntries(Object.entries({ "x-router-monitor-id": ident(requestId),
    "x-router-monitor-session": ident(context.sessionId), "x-router-monitor-thread": ident(context.threadId) })
    .filter(([, v]) => v !== undefined));
}

/** Record caller-visible timing once, independently from provider billing attempts. */
export function monitoring_record_request(fields, context = {}) {
  if (!monitoring_settings().enabled) return;
  const row = { kind: "request", ...monitoring_context({ requestId: fields.requestId || context.requestId,
    provider: fields.provider, model: fields.model }), ...context };
  for (const key of ["status", "durationMs", "responseStartMs", "firstTokenMs", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "retries"])
    if (finite(fields[key])) row[key] = fields[key];
  for (const key of ["streamAborted", "emptyCompletion", "emptyCompletionRetried", "emptyCompletionUnrepairable"])
    if (typeof fields[key] === "boolean") row[key] = fields[key];
  if (ident(fields.failoverFrom)) row.failoverFrom = fields.failoverFrom;
  append(row);
}

/** Observe only safe structured fields from a raw provider JSON/SSE envelope. */
export function monitoring_observe_payload(state, payload) {
  if (!payload || typeof payload !== "object") return;
  const p = payload.response || payload;
  for (const [key, value] of Object.entries({ generationId: p.id, upstreamHost: p.provider || p.provider_name,
    servedModel: p.model, actualServiceTier: p.service_tier })) {
    if (ident(value)) state[key] = value;
  }
  const usage = p.usage;
  if (usage && typeof usage === "object") {
    const values = { inputTokens: usage.input_tokens ?? usage.prompt_tokens,
      cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens,
      cacheWriteTokens: usage.input_tokens_details?.cache_write_tokens ?? usage.prompt_tokens_details?.cache_write_tokens,
      outputTokens: usage.output_tokens ?? usage.completion_tokens,
      reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens,
      costUsd: state.provider === "openrouter" ? usage.cost : undefined };
    for (const [k, v] of Object.entries(values)) if (finite(v) && (k === "costUsd" || count(v))) state[k] = v;
    if (state.provider === "openrouter" && finite(usage.cost)) { state.costSource = "provider-reported"; state.currency = "USD"; }
  }
  const finish = p.choices?.[0]?.finish_reason || p.status;
  if (["stop", "tool_calls", "length", "content_filter", "error", "completed", "incomplete", "failed"].includes(finish)) state.finishReason = finish;
  if (p.error || payload.type === "error" || payload.type === "response.failed") state.streamError = true;
  const type = payload.type || "";
  const delta = p.choices?.[0]?.delta;
  const reasoning = Boolean(delta?.reasoning || delta?.reasoning_content || /reasoning.*\.delta$/.test(type));
  const generated = reasoning || Boolean(delta?.content || delta?.tool_calls?.length || /(?:output_text|function_call_arguments|custom_tool_call_input)\.delta$/.test(type));
  if (generated && state.firstTokenMs === undefined) state.firstTokenMs = Date.now() - state.startedAt;
  if (reasoning) state.reasoningStreamed = true;
  if (!reasoning && generated && state.firstVisibleTokenMs === undefined) state.firstVisibleTokenMs = Date.now() - state.startedAt;
}

/** Byte-transparent fetch observer. Captures raw upstream billing before gateway translation. */
export async function monitoring_fetch(url, init, context = {}, fetchImpl = globalThis.fetch) {
  if (!monitoring_settings().enabled) return fetchImpl(url, init);
  const startedAt = Date.now();
  const state = { ...context, kind: "attempt", attemptId: randomUUID(), startedAt };
  try { state.endpointOrigin = new URL(url).origin; } catch { /* No arbitrary URL text retained. */ }
  let done = false;
  const finish = (extra = {}) => {
    if (done) return;
    done = true;
    append({ ...state, ...extra, durationMs: Date.now() - startedAt });
  };
  let upstream;
  try { upstream = await fetchImpl(url, init); }
  catch (error) { finish({ status: 0, transportError: true }); throw error; }
  state.status = upstream.status;
  state.responseStartMs = Date.now() - startedAt;
  const contentType = upstream.headers.get("content-type") || "";
  const sse = contentType.includes("text/event-stream");
  const parse = sse || contentType.includes("json");
  const reader = upstream.body?.getReader();
  if (!reader) { finish(); return upstream; }
  let buffer = "", droppedFrame = false;
  const decoder = new TextDecoder();
  const observe = text => { try { monitoring_observe_payload(state, JSON.parse(text)); } catch { /* Malformed frames remain unmetered. */ } };
  const consume = (bytes, flush = false) => {
    if (!parse) return;
    const text = decoder.decode(bytes, { stream: !flush });
    if (!sse) {
      if (buffer.length + text.length <= MAX_FRAME && !droppedFrame) buffer += text;
      else { droppedFrame = true; buffer = ""; state.metadataTruncated = true; }
      if (flush && !droppedFrame && buffer) observe(buffer);
      return;
    }
    // Bound a single SSE line even if a provider never terminates it.
    for (const piece of text.split(/(?<=\n)/)) {
      if (!droppedFrame && buffer.length + piece.length <= MAX_FRAME) buffer += piece;
      else { droppedFrame = true; buffer = ""; state.metadataTruncated = true; }
      if (piece.endsWith("\n") || flush) {
        if (!droppedFrame && buffer.startsWith("data:")) observe(buffer.slice(5).trim());
        buffer = ""; droppedFrame = false;
      }
    }
  };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) {
          try { consume(undefined, true); } catch { state.metadataTruncated = true; }
          finish({ completed: true }); controller.close(); return;
        }
        try { consume(item.value); } catch { state.metadataTruncated = true; }
        controller.enqueue(item.value);
      } catch (error) { finish({ streamError: true }); controller.error(error); }
    },
    async cancel(reason) { finish({ canceled: true }); await reader.cancel(reason); },
  });
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
}

/** Explicit task acceptance is append-only and never inferred from HTTP success. */
export function monitoring_outcome({ sessionId, outcome, testsPassed, testsFailed } = {}) {
  if (!ident(sessionId) || !OUTCOMES.has(outcome)) throw new Error("Provide a valid session ID and outcome: passed, failed, needs-correction or abandoned");
  for (const v of [testsPassed, testsFailed]) if (v !== undefined && !count(v)) throw new Error("Test counts must be nonnegative integers");
  const row = { kind: "outcome", sessionId, outcome, ...pick({ testsPassed, testsFailed }, ["testsPassed", "testsFailed"]) };
  append(row); return row;
}

/** Read the retained metadata with malformed-tail tolerance; never mutate old records. */
export function monitoring_records({ days = 30, now = Date.now() } = {}) {
  if (!finite(days) || days > 3650) throw new Error("days must be between 0 and 3650");
  try {
    const cutoff = now - days * DAY;
    const firstDay = new Date(cutoff).toISOString().slice(0, 10);
    const lastDay = new Date(now).toISOString().slice(0, 10);
    const rows = [];
    // Daily shards avoid reading years of retained records for a one-day view.
    for (const name of readdirSync(LEDGER_DIR).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && n.slice(0, 10) >= firstDay && n.slice(0, 10) <= lastDay).sort()) {
      const file = path.join(LEDGER_DIR, name), st = statSync(file), signature = `${st.size}:${st.mtimeMs}`;
      if (readCache.get(file)?.signature !== signature) {
        const items = [];
        for (const line of readFileSync(file, "utf8").split("\n")) {
          try { const row = JSON.parse(line); if (row.schemaVersion === 1 && Number.isFinite(Date.parse(row.at))) items.push(row); } catch { /* Partial final line is not a zero-cost request. */ }
        }
        readCache.set(file, { signature, rows: items });
      }
      rows.push(...readCache.get(file).rows.filter(r => Date.parse(r.at) >= cutoff && Date.parse(r.at) <= now));
    }
    while (readCache.size > 100) readCache.delete(readCache.keys().next().value);
    return rows;
  } catch { return []; }
}

const percentile = (values, q) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(q * values.length) - 1] : null;
const average = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const bucket = input => !finite(input) ? "unknown" : input < 32768 ? "0–32K" : input < 131072 ? "32–128K" : input < 524288 ? "128–512K" : "512K+";

function aggregate(rows, settings) {
  const measured = rows.filter(r => finite(r.inputTokens) && finite(r.cachedInputTokens) && r.cachedInputTokens <= r.inputTokens);
  const input = measured.reduce((n, r) => n + r.inputTokens, 0);
  const cache = measured.reduce((n, r) => n + r.cachedInputTokens, 0);
  const priced = rows.filter(r => finite(r.costUsd));
  const output = rows.filter(r => finite(r.outputTokens));
  const cost = priced.length ? priced.reduce((n, r) => n + r.costUsd, 0) : null;
  const times = rows.filter(r => finite(r.durationMs)).map(r => r.durationMs);
  const first = rows.filter(r => finite(r.firstTokenMs)).map(r => r.firstTokenMs);
  const visible = rows.filter(r => finite(r.firstVisibleTokenMs)).map(r => r.firstVisibleTokenMs);
  const speeds = rows.filter(r => finite(r.outputTokens) && finite(r.firstTokenMs) && r.durationMs > r.firstTokenMs && r.completed && !r.streamError && (r.reasoningStreamed || finite(r.reasoningTokens)))
    .map(r => Math.max(0, r.outputTokens - (r.reasoningStreamed ? 0 : r.reasoningTokens || 0)) * 1000 / (r.durationMs - r.firstTokenMs));
  const errors = rows.filter(r => r.status >= 400 || r.transportError || r.streamError).length;
  const retries = rows.reduce((n, r) => n + (r.retries || 0), 0);
  const truncations = rows.filter(r => ["length", "incomplete"].includes(r.finishReason)).length;
  const emptyResponses = rows.filter(r => r.emptyCompletion || r.emptyCompletionUnrepairable).length;
  const warnings = [];
  if (rows.length >= settings.minimumSamples) {
    if (input && cache / input * 100 < settings.cacheWarningPercent) warnings.push("Cache-hit rate below configured threshold");
    if (errors / rows.length * 100 >= settings.errorWarningPercent) warnings.push("Error rate above configured threshold");
    if (priced.length < rows.length) warnings.push("Some request costs are unknown");
    if (measured.length < rows.length) warnings.push("Some cache measurements are unknown");
  }
  if (rows.some(r => r.metadataTruncated)) warnings.push("Oversized metadata frames were skipped");
  if (rows.some(r => r.requestedHosts?.length && r.upstreamHost && !r.requestedHosts.some(h => h.toLowerCase().replace(/[^a-z0-9]/g, "") === r.upstreamHost.toLowerCase().replace(/[^a-z0-9]/g, "")))) warnings.push("Reported host differs from requested host list");
  return { requests: rows.length, errors, retries, truncations, emptyResponses, cancellations: rows.filter(r => r.canceled || r.status === 0 && !r.transportError).length,
    meteredRequests: output.length, costCoveredRequests: priced.length, cacheCoveredRequests: measured.length,
    inputTokens: measured.length ? input : null, cachedInputTokens: measured.length ? cache : null,
    outputTokens: output.length ? output.reduce((n, r) => n + r.outputTokens, 0) : null,
    cacheHitPercent: input ? cache / input * 100 : null, costUsd: cost,
    costWithFeeUsd: cost === null ? null : priced.reduce((n, r) => n + r.costUsd * (r.provider === "openrouter" ? 1 + settings.feePercent / 100 : 1), 0),
    p50DurationMs: percentile(times, .5), p95DurationMs: percentile(times, .95),
    p50FirstTokenMs: percentile(first, .5), p95FirstTokenMs: percentile(first, .95),
    p50VisibleTokenMs: percentile(visible, .5), p95VisibleTokenMs: percentile(visible, .95),
    p50TokensPerSecond: percentile(speeds, .5), meanDurationMs: average(times), warnings };
}

/** Compare request performance and raw billing separately; never add both observation points. */
export function monitoring_snapshot({ rows = monitoring_records(), budgetRows = rows, settings = monitoring_settings(), now = Date.now() } = {}) {
  const corrections = new Map(rows.filter(r => r.kind === "reconciliation").map(r => [r.attemptId, r]));
  const requests = rows.filter(r => r.kind === "request");
  const attempts = rows.filter(r => r.kind === "attempt").map(r => {
    const correction = corrections.get(r.attemptId);
    return correction ? { ...r, ...pick(correction, ["costUsd", "costSource", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "upstreamHost", "servedModel"]), reconciled: true } : r;
  });
  const group = (records, key) => {
    const groups = new Map();
    for (const row of records) { const id = key(row); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(row); }
    return [...groups].map(([id, items]) => ({ id, ...aggregate(items, settings) }));
  };
  const routes = group(attempts, r => [r.provider, r.upstreamHost || (r.provider === "openrouter" ? "host unknown" : r.provider), r.servedModel || r.model].join(" | "));
  const matched = group(attempts, r => [r.provider, r.upstreamHost || "unknown", r.model, r.reasoningEffort || "effort unknown", bucket(r.inputTokens)].join(" | "));
  const callerRoutes = group(requests, r => `${r.provider} | ${r.model}`);
  const outcomes = new Map();
  for (const row of rows.filter(r => r.kind === "outcome")) outcomes.set(row.sessionId, row);
  const sessions = group(attempts.filter(r => r.sessionId || r.threadId), r => r.sessionId || r.threadId)
    .map(row => ({ ...row, outcome: outcomes.get(row.id)?.outcome || "unassessed" }));
  const recent = attempts.slice(-100).reverse().map(row => pick(row, ["at", "requestId", "attemptId", "generationId", "provider", "upstreamHost", "model", "servedModel", "sessionId", "status", "costUsd", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "firstTokenMs", "firstVisibleTokenMs", "durationMs", "completed", "canceled", "streamError", "reasoningEffort", "finishReason"]));
  const alerts = routes.flatMap(r => r.warnings.map(message => ({ route: r.id, message })));
  const priceHistory = rows.filter(r => r.kind === "prices");
  const latestPrices = priceHistory.at(-1);
  const previousPrices = priceHistory.at(-2);
  if (latestPrices && previousPrices && latestPrices.model === previousPrices.model) {
    for (const endpoint of latestPrices.endpoints) {
      const old = previousPrices.endpoints.find(e => e.host === endpoint.host);
      if (old && JSON.stringify(old.pricing) !== JSON.stringify(endpoint.pricing)) alerts.push({ route: endpoint.host, message: "Published price changed since previous saved snapshot" });
    }
  }
  for (const r of routes) {
    const direct = routes.find(d => d.id.startsWith("deepseek |") && d.cacheHitPercent !== null);
    if (direct && !r.id.startsWith("deepseek |") && r.requests >= settings.minimumSamples && r.cacheHitPercent !== null && direct.cacheHitPercent - r.cacheHitPercent >= 5)
      alerts.push({ route: r.id, message: "Cache-hit rate is over five percentage points below the direct DeepSeek sample; task mix may differ" });
  }
  const budget = (name, since, limit) => {
    const adjustments = new Map(budgetRows.filter(r => r.kind === "reconciliation").map(r => [r.attemptId, r]));
    const items = budgetRows.filter(r => r.kind === "attempt" && Date.parse(r.at) >= since && r.provider === "openrouter")
      .map(r => adjustments.has(r.attemptId) ? { ...r, ...pick(adjustments.get(r.attemptId), ["costUsd"]) } : r);
    const known = items.filter(r => finite(r.costUsd));
    const spend = known.reduce((n, r) => n + r.costUsd, 0) * (1 + settings.feePercent / 100);
    if (limit !== null && spend >= limit) alerts.push({ route: "openrouter", message: `${name} budget reached (known costs only)` });
    return { spendUsd: spend, limitUsd: limit, unknownCosts: items.length - known.length };
  };
  const utc = new Date(now);
  const collectorHealth = [];
  try {
    for (const name of readdirSync(LEDGER_DIR).filter(n => /^health-\d+\.json$/.test(n)).slice(-100)) {
      try {
        const h = JSON.parse(readFileSync(path.join(LEDGER_DIR, name), "utf8"));
        if (count(h.pid) && finite(h.writeFailures) && Number.isFinite(Date.parse(h.lastWriteAt))) collectorHealth.push(h);
      } catch { /* An unavailable heartbeat stays unknown. */ }
    }
  } catch { /* A new install has no heartbeat yet. */ }
  return { version: 1, generatedAt: new Date(now).toISOString(), settings, routes, matched, callerRoutes, collectorHealth,
    sessions: sessions.slice(-100), recent, alerts, latestPrices, requestCount: requests.length, attemptCount: attempts.length,
    unlinkedAttempts: attempts.filter(r => !r.requestId).length, writeFailures,
    dailyBudget: budget("Daily UTC", Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate()), settings.dailyBudgetUsd),
    monthlyBudget: budget("Monthly UTC", Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth(), 1), settings.monthlyBudgetUsd),
    limitations: ["Costs are reported inference charges; fee-inclusive values are estimates using the configured fee.",
      "Unknown costs and cache counts are not zero. Direct-provider costs may need account reconciliation.",
      "Matched groups control context size and requested effort, not task difficulty. Task outcomes require explicit assessment.",
      "Budgets use UTC and the loaded observation window. They warn and never interrupt or reroute requests."] };
}

/** Reconcile incomplete OpenRouter attempts by generation ID, explicitly and without inference. */
export async function monitoring_reconcile({ apiKey, rows = monitoring_records(), fetchImpl = globalThis.fetch, limit = 50 } = {}) {
  if (typeof apiKey !== "string" || !apiKey) throw new Error("An existing OpenRouter credential is required");
  if (!count(limit) || limit < 1 || limit > 200) throw new Error("limit must be 1–200");
  const already = new Set(rows.filter(r => r.kind === "reconciliation").map(r => r.attemptId));
  const candidates = rows.filter(r => r.kind === "attempt" && r.provider === "openrouter" && r.generationId
    && (!finite(r.costUsd) || !r.upstreamHost) && !already.has(r.attemptId)).slice(-limit);
  let reconciled = 0, unavailable = 0;
  for (const row of candidates) {
    try {
      const response = await fetchImpl(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(row.generationId)}`,
        { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000), redirect: "error" });
      if (!response.ok) { unavailable += 1; continue; }
      const { data } = await response.json();
      const patch = { kind: "reconciliation", attemptId: row.attemptId };
      for (const [key, value] of Object.entries({ costUsd: data?.total_cost, inputTokens: data?.native_tokens_prompt,
        cachedInputTokens: data?.native_tokens_cached, outputTokens: data?.native_tokens_completion, reasoningTokens: data?.native_tokens_reasoning }))
        if (finite(value)) patch[key] = value;
      if (ident(data?.provider_name)) patch.upstreamHost = data.provider_name;
      if (ident(data?.model)) patch.servedModel = data.model;
      if (patch.costUsd !== undefined) patch.costSource = "generation-api";
      if (Object.keys(patch).length <= 2) { unavailable += 1; continue; }
      append(patch); reconciled += 1;
    } catch { unavailable += 1; }
  }
  return { attempted: candidates.length, reconciled, unavailable };
}

/** Export the complete selected window, never just the UI's recent sample. */
export function monitoring_export(rows, format = "json") {
  if (format === "json") return JSON.stringify(rows, null, 2);
  if (format !== "csv") throw new Error("Export format must be json or csv");
  const keys = [...new Set(rows.flatMap(Object.keys))].sort();
  const cell = value => {
    let text = value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [keys.map(cell).join(","), ...rows.map(r => keys.map(k => cell(r[k])).join(","))].join("\n");
}

/** Fetch public price metadata only, on explicit request. No inference or credential is used. */
export async function monitoring_refresh_prices(model = "deepseek/deepseek-v4.1-flash-1017", fetchImpl = globalThis.fetch) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:-]+$/.test(model)) throw new Error("Invalid model ID");
  const response = await fetchImpl(`https://openrouter.ai/api/v1/models/${model.split("/").map(encodeURIComponent).join("/")}/endpoints`,
    { signal: AbortSignal.timeout(15_000), redirect: "error" });
  if (!response.ok) throw new Error(`Price lookup returned HTTP ${response.status}`);
  const payload = await response.json();
  const endpoints = (payload.data?.endpoints || []).slice(0, 200).map(e => ({ host: ident(e.tag), precision: ident(e.quantization),
    pricing: Object.fromEntries(Object.entries(e.pricing || {}).filter(([k, v]) => ["prompt", "completion", "input_cache_read", "discount"].includes(k) && Number.isFinite(Number(v)) && Number(v) >= 0)) }));
  append({ kind: "prices", model, endpoints });
  return { model, endpoints };
}
