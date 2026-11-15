# Native bridge dispatch

## Purpose

The Rust bridge authenticates local clients, registers editor roots, binds browser sessions to roots, owns per-session MCP processes, and returns normalized results (`src/bin/relay-bridge.rs:296-379`, `src/bin/relay-bridge.rs:392-575`).

## Calls and lifecycle

- `main` loads configuration/token, starts global configured servers, binds loopback, writes instance metadata, accepts clients, expires leases, and shuts down children (`src/bin/relay-bridge.rs:312-369`, `src/bin/relay-bridge.rs:759-805`).
- `client` checks origin/native authorization, sends initial state, parses messages, limits concurrent long requests to 16, and unregisters the editor owner on disconnect (`src/bin/relay-bridge.rs:632-756`).
- `handle` routes workspace/session/capability requests after constant-work token comparison (`src/bin/relay-bridge.rs:303-310`, `src/bin/relay-bridge.rs:392-575`).
- `Session.call` resolves the namespaced MCP tool, races workspace/session closure, and validates before/after execution (`src/bin/bridge/workspace-registry.rs:163-182`).

## Invariants

- Only native authenticated connections register roots (`src/bin/relay-bridge.rs:403-413`).
- Session validity depends on both session cancellation and the owning workspace lease (`src/bin/bridge/workspace-registry.rs:134-142`).
- Changing access restarts all session MCP servers with the new `RELAY_ACCESS_MODE` (`src/bin/bridge/workspace-registry.rs:146-161`).
- Operation receipts accept one payload per 64-hex identity and retain at most 1024 identities per session (`src/bin/bridge/execution-journal.rs:17-42`).

## Assumptions and open questions

- Assumes configured local MCP commands and environment are operator-controlled (`src/bin/relay-bridge.rs:153-204`).
- Open: is starting global configured servers before any bound browser session intentional, given sessions also own server maps (`src/bin/relay-bridge.rs:361-369`, `src/bin/bridge/workspace-registry.rs:126-133`)?
- Open: what externally observable event distinguishes an action still executing from an action whose socket response was lost? Activity is in-memory and bounded (`src/bin/relay-bridge.rs:381-390`).
