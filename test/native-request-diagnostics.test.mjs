import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marker = "private-prompt-argument-output-ciphertext-marker";
const upstreamId = "dd6bf029-1b55-4c08-b46a-99f470cc13eb";

async function withNativeRouter(handler, check) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "native-diagnostic-test-"));
  const port = await openPort();
  const callerKey = "test-diagnostic-caller-capability-with-sufficient-length";
  const base = callerBaseUrl(port, callerKey);
  const child = spawn(process.execPath, [path.join(root, "src/router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_STATE_DIR: stateDir,
      CODEX_ROUTER_PORT: String(port),
      CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${server.address().port}/backend-api/codex`,
      CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      CODEX_ROUTER_CALLER_KEY: callerKey,
      CODEX_ROUTER_INTERNAL_KEY: "test-diagnostic-internal-key-with-sufficient-length",
      CODEX_ROUTER_QUIET: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let logs = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { logs += chunk; });
  try {
    const deadline = Date.now() + 5_000;
    while (true) {
      assert.equal(child.exitCode, null, logs);
      try { if ((await fetch(`${base}/models`)).ok) break; } catch { /* Starting. */ }
      assert.ok(Date.now() < deadline, logs);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await check(base, () => logs);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await new Promise((resolve) => server.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test("native rejection keeps wire bytes/status/body and logs bounded private diagnostics", async () => {
  const received = [];
  const errorBody = JSON.stringify({ detail: "Bad Request", private: marker });
  await withNativeRouter(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ body: Buffer.concat(chunks), encoding: request.headers["content-encoding"] });
    response.writeHead(400, {
      "Content-Type": "application/json",
      "x-oai-request-id": upstreamId,
      "x-private-test-header": marker,
    });
    response.end(errorBody);
  }, async (base, logs) => {
    for (const repeat of [1, 8_000]) {
      const payload = {
        model: "gpt-5.6-sol",
        tools: [{ type: "function", name: "example", parameters: { type: "object" } }],
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: marker.repeat(repeat) }] },
          { type: "function_call", name: "example", call_id: "call_test", arguments: JSON.stringify({ marker }) },
          { type: "function_call_output", call_id: "call_test", output: marker },
        ],
      };
      const result = await fetch(`${base}/responses`, {
        method: "POST",
        headers: { Authorization: "Bearer synthetic-caller", "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert.equal(result.status, 400);
      assert.equal(await result.text(), errorBody);
      assert.equal(result.headers.get("x-oai-request-id"), upstreamId);
      const deadline = Date.now() + 2_000;
      while (logs().split("[codex-router] native-rejection ").length - 1 < received.length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const lines = logs().split("\n").filter((line) => line.startsWith("[codex-router] native-rejection "));
      assert.equal(lines.length, received.length, "each failed request needs one diagnostic even in quiet mode");
      const diagnostic = JSON.parse(lines.at(-1).split("native-rejection ")[1]);
      const wire = received.at(-1);
      assert.equal(diagnostic.wireBodySha256, createHash("sha256").update(wire.body).digest("hex"));
      assert.equal(diagnostic.wireBodyBytes, wire.body.length);
      assert.equal(diagnostic.status, 400);
      assert.equal(diagnostic.upstreamRequestId, upstreamId);
      assert.equal(diagnostic.input.matchedCallIds, 1);
      assert.equal(diagnostic.input.orphanOutputItems, 0);
      assert.ok(lines.at(-1).length < 2_048);
      const outgoing = JSON.parse((wire.encoding === "zstd" ? zstdDecompressSync(wire.body) : wire.body).toString("utf8"));
      assert.deepEqual(outgoing, payload, "diagnostics must not normalize or otherwise rewrite the native request");
    }
    assert.equal(received.length, 2, "HTTP 400 must never be retried");
    assert.equal(received[0].encoding, undefined);
    assert.equal(received[1].encoding, "zstd");
    assert.equal(logs().includes(marker), false, "prompts, arguments, output, response text and headers stay private");
  });
});

test("native diagnostic counts matching and ambiguous pairs without retaining content", async () => {
  const { nativeRequestDiagnostics_observer } = await import("../src/native-request-diagnostics.mjs");
  const payload = { tools: [{ type: "namespace", name: marker }], input: [
    { type: "message", role: "user", content: marker },
    { type: "reasoning", encrypted_content: marker },
    { type: "function_call_output", call_id: "early", output: marker },
    { type: "function_call", call_id: "early", arguments: marker },
    { type: "function_call", call_id: "duplicate" },
    { type: "function_call", call_id: "duplicate" },
    { type: "custom_tool_call_output", call_id: "duplicate" },
    { type: "custom_tool_call_output", call_id: "duplicate" },
    { type: "custom_tool_call", call_id: "pending", input: marker },
    { type: "function_call_output", call_id: "orphan" },
    { type: "function_call" },
    { type: "function_call_output", call_id: 123 },
    { type: marker },
  ] };
  const wire = Buffer.from(JSON.stringify(payload));
  const original = Buffer.from(wire);
  const lines = [];
  const observe = nativeRequestDiagnostics_observer(wire, payload, { log: (line) => lines.push(line) });
  observe(200, upstreamId);
  assert.deepEqual(lines, []);
  observe(400, upstreamId);
  assert.ok(wire.equals(original));
  const result = JSON.parse(lines[0].split("native-rejection ")[1]);
  assert.deepEqual({
    matched: result.input.matchedCallIds,
    ambiguous: result.input.ambiguousCallIds,
    duplicatedCalls: result.input.duplicateCallItems,
    duplicatedOutputs: result.input.duplicateOutputItems,
    early: result.input.outputsBeforeCalls,
    mismatchedKinds: result.input.mismatchedKindIds,
    orphan: result.input.orphanOutputItems,
    pending: result.input.callsWithoutOutput,
    invalid: result.input.itemsWithoutCallId,
  }, { matched: 2, ambiguous: 1, duplicatedCalls: 1, duplicatedOutputs: 1,
    early: 1, mismatchedKinds: 1, orphan: 1, pending: 1, invalid: 2 });
  assert.equal(result.input.reasoningWithEncryptedContent, 1);
  assert.equal(result.input.types.other, 1);
  assert.equal(lines[0].includes(marker), false);
});

test("native diagnostics bound inspection, omit unsafe IDs and never affect forwarding", async () => {
  const { nativeRequestDiagnostics_observer } = await import("../src/native-request-diagnostics.mjs");
  const input = Array.from({ length: 20_000 }, (_, i) => ({ type: "function_call", call_id: `call_${i}`, arguments: marker }));
  const payload = { input, tools: Array.from({ length: 20_000 }, () => ({ type: marker })) };
  const lines = [];
  const observe = nativeRequestDiagnostics_observer(Buffer.from("exact wire body"), payload, { log: (line) => lines.push(line) });
  observe(400, `Bearer ${marker}`);
  const result = JSON.parse(lines[0].split("native-rejection ")[1]);
  assert.equal(result.input.items, 20_000);
  assert.equal(result.input.inspectionTruncated, true);
  assert.ok(result.input.inspectedItems <= 4_096);
  assert.equal(result.tools.inspectionTruncated, true);
  assert.equal(result.upstreamRequestId, undefined);
  assert.ok(lines[0].length < 2_048);
  assert.equal(lines[0].includes(marker), false);
  assert.doesNotThrow(() => nativeRequestDiagnostics_observer(Buffer.from("wire"), {}, { log: () => { throw new Error(marker); } })(400, upstreamId));
  assert.doesNotThrow(() => nativeRequestDiagnostics_observer(undefined, {})(400, upstreamId));
});
