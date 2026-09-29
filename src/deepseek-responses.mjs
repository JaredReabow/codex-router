import { agentMessagesAsUserMessages } from "./namespace-relay.mjs";

// The current direct Flash endpoint speaks Responses natively. Keep older
// aliases and reseller routes on their separately verified wire contracts.
export function usesDeepSeekResponses(model) {
  return model?.provider === "deepseek" && model?.upstreamModel === "deepseek-flash";
}

// Current native endpoint aliases, documented in DeepSeek's thinking guide.
// In particular xhigh maps to high; it is not the legacy Chat profile's max.
export function deepSeekResponsesEffort(value) {
  if (value === "none") return "none";
  if (["minimal", "low"].includes(value)) return "low";
  return ["max", "ultra"].includes(value) ? "max" : "high";
}

function reasoningContent(value) {
  const texts = typeof value === "string" ? [value]
    : Array.isArray(value) ? value.map((part) => part?.text) : [];
  return texts.filter((text) => typeof text === "string" && text)
    .map((text) => ({ type: "reasoning_text", text }));
}

/** Keep completed tool groups contiguous for the strict DeepSeek replay parser. */
function deepSeekResponsesReplayOrder(input) {
  const outputTypes = new Map([
    ["function_call", "function_call_output"],
    ["custom_tool_call", "custom_tool_call_output"],
  ]);
  const counts = new Map();
  const callCounts = new Map();
  const resultCounts = new Map();
  const resultTypes = new Set(outputTypes.values());
  for (const item of input) {
    if (!outputTypes.has(item?.type) && !resultTypes.has(item?.type)) continue;
    const key = `${item.type}:${item.call_id}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    const identities = outputTypes.has(item.type) ? callCounts : resultCounts;
    identities.set(item.call_id, (identities.get(item.call_id) || 0) + 1);
  }
  const paired = (item) => outputTypes.has(item?.type) &&
    typeof item.call_id === "string" && item.call_id.length > 0 &&
    callCounts.get(item.call_id) === 1 && resultCounts.get(item.call_id) === 1 &&
    counts.get(`${item.type}:${item.call_id}`) === 1 &&
    counts.get(`${outputTypes.get(item.type)}:${item.call_id}`) === 1;
  const output = [];
  for (let index = 0; index < input.length;) {
    if (!paired(input[index])) { output.push(input[index++]); continue; }
    const start = index;
    const calls = [];
    const comments = [];
    const pending = new Map();
    // Codex may persist a streamed assistant comment after its tool call but
    // before the tool result. DeepSeek treats that comment as a new assistant
    // turn and reports a missing result, even though the result follows it.
    while (index < input.length) {
      const item = input[index];
      if (paired(item)) {
        calls.push(item);
        pending.set(item.call_id, outputTypes.get(item.type));
      } else if (item?.type === "message" && item.role === "assistant") {
        comments.push(item);
      } else break;
      index += 1;
    }
    const resultsStart = index;
    while (pending.size && index < input.length) {
      const item = input[index];
      if (!item || !pending.has(item.call_id) || pending.get(item.call_id) !== item.type) break;
      pending.delete(item.call_id);
      index += 1;
    }
    // Only move comments from the same completed tool group. Never cross user
    // instructions or other items, invent a result, or repair ambiguous IDs.
    // All item contents and call/result order remain intact; source is read-only.
    if (!pending.size && comments.length) {
      output.push(...comments, ...calls, ...input.slice(resultsStart, index));
    } else output.push(...input.slice(start, index));
  }
  return output;
}

// Plaintext reasoning uses an array of reasoning_text parts, not a JSON string.
// DeepSeek ignores summary/encrypted_content; older Chat-bridged turns can have
// only a summary. Replay its text once as reasoning, preserving part boundaries.
export function deepSeekResponsesInput(input) {
  if (!Array.isArray(input)) return input;
  // The task text is already recovered; expose Codex handoffs as ordinary
  // messages because the public endpoint does not understand agent_message.
  return deepSeekResponsesReplayOrder(agentMessagesAsUserMessages(input)).flatMap((item) => {
    if (item?.type !== "reasoning") return [item];
    let content = reasoningContent(item.content);
    if (!content.length) content = reasoningContent(item.summary);
    return content.length ? [{ type: "reasoning", content }] : [];
  });
}

// Only apply_patch has a native custom-tool contract at this endpoint. Other
// Codex freeform tools use the existing reversible function-tool bridge.
export function deepSeekCustomToolNames(tools, input, choice) {
  const names = new Set();
  const add = (type, name) => {
    if ((type === "custom" || type === "custom_tool_call") &&
        typeof name === "string" && name && name !== "apply_patch") names.add(name);
  };
  for (const tool of Array.isArray(tools) ? tools : []) add(tool?.type, tool?.name);
  for (const item of Array.isArray(input) ? input : []) add(item?.type, item?.name);
  add(choice?.type, choice?.name);
  for (const tool of choice?.type === "allowed_tools" && Array.isArray(choice.tools)
    ? choice.tools : []) add(tool?.type, tool?.name);
  return [...names];
}
