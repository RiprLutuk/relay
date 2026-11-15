# Architecture audit — 14 November 2026

## Assessment

Relay has sound separation between provider DOM adapters, browser orchestration, authenticated native routing, editor workspace registration and MCP tools. The end-to-end action path is documented in [architecture](architecture.md). Rust owns the security boundary; TypeScript owns host-specific UX.

## Findings

| Priority | Finding and evidence | Impact | Remediation |
| --- | --- | --- | --- |
| P0 | Browser test failures were accumulated through `process.exitCode` while later child tests continued (`scripts/test-browser.ts`). A reproduced failing assertion still returned a successful parent run. | A broken browser release could pass the main gate. | Fixed with an explicit failure accumulator and final non-zero exit. |
| P1 | Connection health was represented by booleans in `bridge-link.ts` and `editor-session.ts`; heartbeats existed but freshness and latency were discarded. | UI could say offline/connected without distinguishing handshake, reconnect or degradation. | Added explicit phases, measured heartbeat health, jittered backoff and Control Center latency. |
| P1 | Successful native results had no final status, duration or action identity (`relay-bridge.rs: capability.invoke`). | An acknowledgement and completed execution were difficult to distinguish and correlate. | Added structured terminal receipt fields and stable error codes while preserving the human receipt format. |
| P1 | A timed-out action is not automatically replayed and the journal is not queryable by the browser. | The execution outcome can remain unknown after a disconnect. | Next: add a read-only receipt lookup by session/action identity before any retry. |
| P1 | Provider integration relies on rendered DOM selectors and a two-second stability heuristic (`site-profiles.ts`, `run-coordinator.ts`). | Provider UI changes can stop or prematurely parse actions. | Add provider contract fixtures and health diagnostics; keep fail-closed parsing. |
| P2 | Protocol version `3` is hard-coded independently in three components. | Mixed upgrades fail without negotiated compatibility. | Centralize the protocol contract and document a migration window. |
| P2 | Browser/editor Python harnesses are not part of `npm test`. | Release confidence depends on manual execution. | Add an explicit local release gate; do not require CI. |
| P2 | One shared pairing token identifies every browser client. | Pairing cannot be revoked per browser profile/account. | Introduce per-client identities and revocation without exposing account data. |
| P2 | Selected runtime binaries and custom MCP commands are trusted without signature verification. | Local configuration can execute an unintended binary. | Record binary provenance and warn before first use of overrides/custom servers. |
| P3 | Some Rust modules use a crate-wide non-snake-case allowance. | Style debt makes public/internal naming inconsistent. | Remove allowances incrementally after protocol names are isolated. |

## Capability inventory

The native workspace server advertises 24 capabilities grouped under workspace inspection/editing, project checks, process execution and version control. The runtime validates the catalog at session time; the browser rejects names outside that catalog.

## Target architecture

Keep the current three-host design. Evolve it with a versioned protocol contract, queryable execution journal, policy engine at the Rust session boundary, persistent task orchestrator above individual tool calls, verification receipts, and bounded structured diagnostics. No rewrite is justified.

## Migration order

1. Stabilize connection/receipts and close false-green tests.
2. Add policy modes and action-scoped approval.
3. Add persistent task/step state and receipt reconciliation.
4. Add evidence-derived workspace context and verification selection.
5. Expand the existing Control Center only when backend controls exist.
