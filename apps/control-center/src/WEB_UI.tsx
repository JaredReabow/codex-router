/** Monitoring UI: all state and policy are accessed through the control API. */
import { useCallback, useEffect, useState } from "react";
import { Button, SectionHeading } from "./components";
import type { RouterControlApi } from "./types";

interface Metrics {
  id: string; requests: number; errors: number; cancellations: number;
  costUsd: number | null; costWithFeeUsd: number | null; costCoveredRequests: number;
  cacheHitPercent: number | null; cacheCoveredRequests: number; meteredRequests: number;
  p50FirstTokenMs: number | null; p95FirstTokenMs: number | null;
  p50VisibleTokenMs: number | null; p95DurationMs: number | null;
  p50TokensPerSecond: number | null; outcome?: string; warnings: string[];
}
interface Policy {
  enabled: boolean; feePercent: number; minimumSamples: number; cacheWarningPercent: number;
  errorWarningPercent: number; dailyBudgetUsd: number | null; monthlyBudgetUsd: number | null;
}
interface Snapshot {
  generatedAt: string; days: number; settings: Policy; requestCount: number; attemptCount: number;
  unlinkedAttempts: number; writeFailures: number; routes: Metrics[]; matched: Metrics[];
  callerRoutes: Metrics[]; sessions: Metrics[];
  recent: Array<Record<string, unknown>>; alerts: Array<{ route: string; message: string }>;
  latestPrices?: { at: string; model: string; endpoints: Array<{ host?: string; precision?: string; pricing: Record<string, string | number> }> };
  dailyBudget: { spendUsd: number; limitUsd: number | null; unknownCosts: number };
  monthlyBudget: { spendUsd: number; limitUsd: number | null; unknownCosts: number };
  limitations: string[];
}
const money = (v: number | null | undefined) => v == null ? "Unknown" : `$${v.toFixed(4)}`;
const time = (v: number | null | undefined) => v == null ? "Unknown" : `${(v / 1000).toFixed(2)}s`;
const percent = (v: number | null | undefined) => v == null ? "Unknown" : `${v.toFixed(2)}%`;

/** Render measured route comparisons, explicit task assessments and monitoring controls. */
export function MonitoringPanel({ api, refreshing }: { api?: RouterControlApi; refreshing: boolean }) {
  const [data, setData] = useState<Snapshot>();
  const [days, setDays] = useState(30);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [policy, setPolicy] = useState<Policy>();
  const [sessionId, setSession] = useState("");
  const [outcome, setOutcome] = useState("passed");
  const [tab, setTab] = useState<"routes" | "matched" | "callerRoutes" | "sessions">("routes");
  const load = useCallback(async () => {
    if (!api?.monitoring) return;
    try {
      const next = await api.monitoring("status", { days }) as Snapshot;
      setData(next); setPolicy(previous => previous || next.settings); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Monitoring could not be read"); }
  }, [api, days]);
  useEffect(() => { if (!refreshing) void load(); }, [load, refreshing]);
  useEffect(() => { const timer = window.setInterval(() => void load(), 60_000); return () => window.clearInterval(timer); }, [load]);
  const action = async (name: "settings" | "prices" | "reconcile" | "outcome", input: Record<string, unknown>) => {
    if (!api?.monitoring) return;
    setBusy(true); setNotice("");
    try {
      const result = await api.monitoring(name, input);
      setNotice(name === "reconcile" ? `Reconciliation: ${JSON.stringify(result)}` : "Saved");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Monitoring operation failed"); }
    finally { setBusy(false); }
  };
  const download = async (format: "csv" | "json") => {
    if (!api?.monitoring) return;
    try {
      const result = await api.monitoring("export", { days, format }) as { content: string };
      const url = URL.createObjectURL(new Blob([result.content], { type: format === "csv" ? "text/csv" : "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `router-monitoring-${days}d-${new Date().toISOString().slice(0, 10)}.${format}`;
      link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e instanceof Error ? e.message : "Export failed"); }
  };
  const rows = data?.[tab] || [];
  return <section className="monitoring-panel" aria-label="Provider comparison monitoring">
    <style>{`
      .monitoring-panel{border:1px solid var(--border-color,#626875);border-radius:12px;padding:20px;margin:20px 0;min-width:0}
      .monitoring-toolbar,.monitoring-policy{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:12px 0}
      .monitoring-toolbar label,.monitoring-policy label{display:flex;gap:7px;align-items:center}
      .monitoring-panel input,.monitoring-panel select{background:var(--surface,#22252b);color:inherit;border:1px solid #697080;border-radius:5px;padding:6px}
      .monitoring-policy input[type=number]{width:94px}.monitoring-scroll{overflow:auto;max-height:440px}
      .monitoring-panel table{border-collapse:collapse;width:100%;font-size:12px;white-space:nowrap}
      .monitoring-panel th,.monitoring-panel td{padding:10px;text-align:left;border-bottom:1px solid #62687555}
      .monitoring-panel th{position:sticky;top:0;background:var(--surface,#22252b)}
      .monitoring-alert{border-left:3px solid #eab75a;padding:8px 12px;margin:6px 0;overflow-wrap:anywhere}
      .monitoring-panel summary{cursor:pointer;padding:10px 0}.monitoring-panel small{opacity:.8}
      .monitoring-panel .route-name{white-space:normal;min-width:200px;max-width:350px;overflow-wrap:anywhere}
    `}</style>
    <SectionHeading title="Provider comparison" description="Actual hosts, billed inference, cache coverage and timing. No prompt or response text is recorded." />
    <div className="monitoring-toolbar">
      <label>Period <select aria-label="Monitoring period" value={days} onChange={e => setDays(Number(e.target.value))}>
        {[1, 7, 30, 90].map(n => <option key={n} value={n}>{n} days</option>)}
      </select></label>
      <Button onClick={() => void load()} disabled={busy}>Refresh comparison</Button>
      <Button onClick={() => void download("csv")} disabled={!data}>Export CSV</Button>
      <Button onClick={() => void download("json")} disabled={!data}>Export JSON</Button>
    </div>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!data ? <p>Loading monitoring…</p> : <>
      <p>{data.requestCount.toLocaleString()} caller requests · {data.attemptCount.toLocaleString()} observed upstream attempts · {data.unlinkedAttempts.toLocaleString()} attempts without a request link</p>
      <small>Snapshot {new Date(data.generatedAt).toLocaleString()}. Collection {data.settings.enabled ? "enabled" : "disabled"}. Write failures in this reader process: {data.writeFailures}.</small>
      {data.alerts.map((a, i) => <div role="status" className="monitoring-alert" key={`${a.route}-${i}`}><strong>{a.route}</strong>: {a.message}</div>)}
      <div className="monitoring-toolbar"><label>Compare <select aria-label="Monitoring grouping" value={tab} onChange={e => setTab(e.target.value as typeof tab)}>
        <option value="routes">Actual host and model</option><option value="matched">Host, effort and context size</option>
        <option value="callerRoutes">Caller-visible requests</option><option value="sessions">Sessions and task outcomes</option>
      </select></label></div>
      <div className="monitoring-scroll"><table aria-label="Provider performance comparison">
        <thead><tr><th>Route / session</th><th>Requests</th><th>Reported USD</th><th>With fee estimate</th><th>Cost coverage</th><th>Cache hit</th><th>Cache coverage</th><th>First token p50 / p95</th><th>Visible token p50</th><th>Duration p95</th><th>Output tokens/s p50</th><th>Errors / canceled</th><th>Outcome</th></tr></thead>
        <tbody>{rows.map(r => <tr key={r.id}><td className="route-name">{r.id}</td><td>{r.requests.toLocaleString()}</td>
          <td>{money(r.costUsd)}</td><td>{money(r.costWithFeeUsd)}</td><td>{r.costCoveredRequests}/{r.requests}</td>
          <td>{percent(r.cacheHitPercent)}</td><td>{r.cacheCoveredRequests}/{r.requests}</td>
          <td>{time(r.p50FirstTokenMs)} / {time(r.p95FirstTokenMs)}</td><td>{time(r.p50VisibleTokenMs)}</td><td>{time(r.p95DurationMs)}</td>
          <td>{r.p50TokensPerSecond == null ? "Unknown" : r.p50TokensPerSecond.toFixed(1)}</td><td>{r.errors} / {r.cancellations}</td><td>{r.outcome || "Unassessed"}</td></tr>)}</tbody>
      </table></div>
      {!rows.length && <p>No measurements yet for this view. New requests populate it automatically once the updated service is running.</p>}
      <p>OpenRouter known spend with configured fee: today UTC {money(data.dailyBudget.spendUsd)}{data.dailyBudget.limitUsd !== null ? ` / ${money(data.dailyBudget.limitUsd)}` : " (no daily budget)"}; month UTC {money(data.monthlyBudget.spendUsd)}{data.monthlyBudget.limitUsd !== null ? ` / ${money(data.monthlyBudget.limitUsd)}` : " (no monthly budget)"}. Unknown-cost attempts: {data.monthlyBudget.unknownCosts}.</p>
      <details><summary>Request details and reconciliation</summary>
        <p>Reconciliation uses existing generation IDs to read billing records. It does not run model requests.</p>
        <Button disabled={busy} onClick={() => void action("reconcile", { limit: 50 })}>Reconcile up to 50 incomplete records</Button>
        <div className="monitoring-scroll"><table aria-label="Recent monitored requests"><thead><tr><th>Time</th><th>Host</th><th>Model</th><th>Status</th><th>Cost USD</th><th>Generation / request ID</th></tr></thead>
          <tbody>{data.recent.map(r => <tr key={String(r.attemptId)}><td>{String(r.at)}</td><td>{String(r.upstreamHost || "Unknown")}</td><td>{String(r.servedModel || r.model)}</td><td>{String(r.status)}</td><td>{money(r.costUsd as number | undefined)}</td><td>{String(r.generationId || r.requestId || "Unknown")}</td></tr>)}</tbody></table></div>
      </details>
      <details><summary>Task acceptance</summary><p>Record a task result explicitly. A successful API response never marks a coding task as passed.</p>
        <div className="monitoring-toolbar"><label>Session ID <input aria-label="Task session ID" value={sessionId} onChange={e => setSession(e.target.value)} /></label>
          <label>Result <select aria-label="Task outcome" value={outcome} onChange={e => setOutcome(e.target.value)}><option value="passed">Passed</option><option value="failed">Failed</option><option value="needs-correction">Needs correction</option><option value="abandoned">Abandoned</option></select></label>
          <Button disabled={busy || !sessionId} onClick={() => void action("outcome", { sessionId, outcome })}>Record outcome</Button></div>
      </details>
      <details><summary>Price history</summary><p>Save current public prices for later drift comparisons. This makes a public metadata request, without inference.</p>
        <Button disabled={busy} onClick={() => void action("prices", { model: "deepseek/deepseek-v4.1-flash-1017" })}>Save current DeepSeek host prices</Button>
        {data.latestPrices && <><p>Last saved {data.latestPrices.at}</p><div className="monitoring-scroll"><table><thead><tr><th>Endpoint</th><th>Precision</th><th>Input / cache / output per million USD</th><th>Advertised discount</th></tr></thead><tbody>{data.latestPrices.endpoints.map(e => <tr key={e.host}><td>{e.host}</td><td>{e.precision || "Unknown"}</td><td>{["prompt", "input_cache_read", "completion"].map(k => e.pricing[k] === undefined ? "Unknown" : `$${(Number(e.pricing[k]) * 1e6).toFixed(6)}`).join(" / ")}</td><td>{e.pricing.discount === undefined ? "Unknown" : percent(Number(e.pricing.discount) * 100)}</td></tr>)}</tbody></table></div></>}
      </details>
      <details><summary>Monitoring settings and budgets</summary>{policy && <>
        <div className="monitoring-policy"><label><input type="checkbox" checked={policy.enabled} onChange={e => setPolicy({ ...policy, enabled: e.target.checked })} />Collect metadata</label>
          {(["feePercent", "minimumSamples", "cacheWarningPercent", "errorWarningPercent", "dailyBudgetUsd", "monthlyBudgetUsd"] as const).map(key => <label key={key}>{({feePercent:"OpenRouter fee estimate %", minimumSamples:"Minimum alert samples", cacheWarningPercent:"Cache warning below %",errorWarningPercent:"Error warning at %",dailyBudgetUsd:"Daily UTC budget USD",monthlyBudgetUsd:"Monthly UTC budget USD"})[key]}
            <input type="number" aria-label={key} min="0" step={key === "minimumSamples" ? "1" : "0.01"} value={policy[key] ?? ""} onChange={e => setPolicy({ ...policy, [key]: e.target.value === "" && key.endsWith("BudgetUsd") ? null : Number(e.target.value) })} /></label>)}
        </div><Button disabled={busy} onClick={() => void action("settings", { ...policy })}>Save monitoring settings</Button></>}
      </details>
      <details><summary>Measurement limits</summary><ul>{data.limitations.map(text => <li key={text}>{text}</li>)}</ul></details>
    </>}
  </section>;
}
