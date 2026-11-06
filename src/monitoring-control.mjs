/** Fixed monitoring operations shared by CLI and desktop IPC. */
import { monitoring_settings, monitoring_set_settings, monitoring_records, monitoring_snapshot,
  monitoring_outcome, monitoring_export, monitoring_refresh_prices, monitoring_reconcile } from "./request-monitoring.mjs";

/** Execute an explicit monitoring operation; inference is never invoked here. */
export async function monitoring_control(action = "status", input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid monitoring input");
  if (action === "settings") return monitoring_set_settings(input);
  if (action === "outcome") return monitoring_outcome(input);
  if (action === "prices") return monitoring_refresh_prices(input.model);
  if (action === "reconcile") {
    const { resolveProviderCredential } = await import("./provider-credentials.mjs");
    const credential = resolveProviderCredential("openrouter");
    return monitoring_reconcile({ apiKey: credential?.value, limit: input.limit ?? 50 });
  }
  const days = input.days ?? 30;
  const rows = monitoring_records({ days });
  if (action === "export") return { format: input.format || "json", days, content: monitoring_export(rows, input.format || "json") };
  if (action !== "status") throw new Error("Monitoring action must be status, settings, outcome, prices, reconcile or export");
  return { ...monitoring_snapshot({ rows, budgetRows: days < 31 ? monitoring_records({ days: 31 }) : rows }), days, policy: monitoring_settings() };
}
