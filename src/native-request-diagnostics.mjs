/** Content-free metadata for otherwise opaque native request rejections. */
import { createHash } from "node:crypto";

const MAX_INSPECTED_ITEMS = 4_096;
const INPUT_TYPES = Object.freeze([
  "message", "reasoning", "function_call", "function_call_output",
  "custom_tool_call", "custom_tool_call_output", "agent_message",
  "item_reference", "compaction", "other",
]);
const TOOL_TYPES = Object.freeze(["function", "custom", "namespace", "other"]);
const CALL_TYPES = new Map([["function_call", "function"], ["custom_tool_call", "custom"]]);
const OUTPUT_TYPES = new Map([["function_call_output", "function"], ["custom_tool_call_output", "custom"]]);

/** Count a bounded prefix; identifiers exist only in this temporary pairing map. */
function inputSummary(input) {
  const items = Array.isArray(input) ? input : [];
  const types = Object.fromEntries(INPUT_TYPES.map((type) => [type, 0]));
  const summary = {
    items: items.length,
    inspectedItems: Math.min(items.length, MAX_INSPECTED_ITEMS),
    inspectionTruncated: items.length > MAX_INSPECTED_ITEMS,
    types,
    reasoningWithEncryptedContent: 0,
    itemsWithoutCallId: 0,
    duplicateCallItems: 0,
    duplicateOutputItems: 0,
    matchedCallIds: 0,
    ambiguousCallIds: 0,
    mismatchedKindIds: 0,
    outputsBeforeCalls: 0,
    orphanOutputItems: 0,
    callsWithoutOutput: 0,
  };
  const calls = new Map();
  const outputs = new Map();
  for (let index = 0; index < summary.inspectedItems; index += 1) {
    const item = items[index];
    const type = Object.hasOwn(types, item?.type) ? item.type : "other";
    types[type] += 1;
    if (type === "reasoning" && typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
      summary.reasoningWithEncryptedContent += 1;
    }
    const callKind = CALL_TYPES.get(type);
    const outputKind = OUTPUT_TYPES.get(type);
    if (!callKind && !outputKind) continue;
    const id = item.call_id;
    if (typeof id !== "string" || id.length === 0 || id.length > 200) {
      summary.itemsWithoutCallId += 1;
      continue;
    }
    const entries = callKind ? calls : outputs;
    const previous = entries.get(id);
    if (previous) {
      previous.count += 1;
      if (callKind) summary.duplicateCallItems += 1;
      else summary.duplicateOutputItems += 1;
    } else {
      entries.set(id, { index, count: 1, kind: callKind || outputKind });
    }
  }
  for (const [id, output] of outputs) {
    const call = calls.get(id);
    if (!call) {
      summary.orphanOutputItems += output.count;
      continue;
    }
    summary.matchedCallIds += 1;
    if (call.count > 1 || output.count > 1) summary.ambiguousCallIds += 1;
    if (call.kind !== output.kind) summary.mismatchedKindIds += 1;
    if (output.index < call.index) summary.outputsBeforeCalls += 1;
  }
  for (const id of calls.keys()) if (!outputs.has(id)) summary.callsWithoutOutput += 1;
  return summary;
}

/** Tool names, schemas and nested definitions are deliberately not retained. */
function toolSummary(tools) {
  const items = Array.isArray(tools) ? tools : [];
  const types = Object.fromEntries(TOOL_TYPES.map((type) => [type, 0]));
  const inspectedItems = Math.min(items.length, MAX_INSPECTED_ITEMS);
  for (let index = 0; index < inspectedItems; index += 1) {
    const type = Object.hasOwn(types, items[index]?.type) ? items[index].type : "other";
    types[type] += 1;
  }
  return { rootDefinitions: items.length, inspectedItems,
    inspectionTruncated: items.length > MAX_INSPECTED_ITEMS, types };
}

/** Accept bounded provider request IDs, never arbitrary header text. */
function safeUpstreamRequestId(value) {
  return typeof value === "string" && (
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ||
    /^req_[A-Za-z0-9]{1,96}$/.test(value)
  ) ? value : undefined;
}

// This separate scope retains only the fixed-schema metadata, not the payload
// or its already-serialized body. Logging must never change forwarding behavior.
function errorObserver(metadata, log) {
  return (status, upstreamRequestId) => {
    if (!metadata || !Number.isInteger(status) || status < 400 || status > 599) return;
    try {
      log(`[codex-router] native-rejection ${JSON.stringify({ ...metadata, status,
        upstreamRequestId: safeUpstreamRequestId(upstreamRequestId) })}`);
    } catch { /* A diagnostic failure must not replace the original response. */ }
  };
}

/**
 * Observe a final native rejection without rewriting, retaining or retrying it.
 * Hash the exact outgoing bytes before fetch can detach their backing buffer.
 * Counts describe at most 4,096 root items; truncation is explicit. This cannot
 * establish why OpenAI rejected a request or prove two different hashes differ
 * semantically (native encrypted continuation tokens may themselves change).
 */
export function nativeRequestDiagnostics_observer(serializedBody, payload, { log = console.error } = {}) {
  let metadata;
  try {
    if (Buffer.isBuffer(serializedBody)) {
      metadata = {
        schemaVersion: 1,
        wireBodySha256: createHash("sha256").update(serializedBody).digest("hex"),
        wireBodyBytes: serializedBody.length,
        input: inputSummary(payload?.input),
        tools: toolSummary(payload?.tools),
      };
    }
  } catch { /* Metadata is optional; the original request still proceeds. */ }
  return errorObserver(metadata, log);
}
