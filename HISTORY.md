# History

## 2026-11-10 — Codex HTTP transport compatibility

Managed signed and login-free providers now advertise HTTP/SSE, matching the local adapter’s supported protocol. Previously generated WebSocket-enabled blocks remain recognized for safe migration and restoration. Installed-client regression coverage verifies HTTP POST, streaming completion, and zero WebSocket upgrades. Existing sessions require a reload to adopt the capability. HX6 firmware and unrelated binary-discovery work are unchanged.
