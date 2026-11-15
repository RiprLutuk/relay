# Changelog

## 1.0.2 — 2026-11-15

- Keeps the agent loop moving after an action receipt instead of asking the user to forward another message through Relay.
- Makes receipt delivery explicitly automatic and tells the AI to continue with the next required action or finish the task.
- Prevents completed operations from being repeated while continuing a run.

## 1.0.1 — 2026-11-15

- Isolates workspace sessions by browser tab so matching conversation URLs from different accounts cannot overwrite one another.
- Keeps ChatGPT sessions active while a new chat moves through its temporary route to its permanent conversation URL.
- Preserves active sessions across provider reloads and account-specific routes.
- Executes one intended Relay action when a provider adds progress text or omits the optional fence.
- Replaces an older running Relay daemon automatically after an extension upgrade.
- Preserves an unsent chat draft while Relay starts or returns an action receipt.
- Stops an obsolete content script quietly after the browser extension is reloaded.
- Confirms internal message delivery from the rendered ChatGPT user turn when the composer does not clear immediately.
- Adds explicit connection health, action timing, stable error codes and strict browser test failure propagation.
- Adds Observe, Supervised and Autonomous access enforced by the Rust session boundary, with exact-action approval in the browser popup.
- Adds dependency-aware `task.execute` batches with bounded parallel reads, serialized mutations and partial step receipts.
- Expands project context with evidence-derived language, framework, package manager, test command and monorepo detection.

## 1.0.0 — 2026-10-30

- One VSIX bundles the editor companion, Rust runtime and browser companion.
- Platform packages cover Windows x64, Linux x64/ARM64 and macOS Intel/Apple Silicon, with native architecture checks and SHA-256 checksums.
- Conversations bind to a specific editor window and project root, with session-scoped access.
- TypeScript browser orchestration provides readable action cards, execution receipts, cancellation and recovery without replaying history.
- Start attaches a missing conversation agent to already-open tabs. Startup errors survive popup refreshes. Claude file creation and read-back are verified live in Brave on macOS.
- Rust routes MCP capabilities, deduplicates retries by operation identity and cancels descendant processes when a session closes.
- VS Code and Cursor bootstrap and browser-to-workspace integration are tested locally. See [verification](docs/verification.md) for coverage and limits.

The initial product release uses bridge protocol 3. Pre-release development history is described in [provenance](PROVENANCE.md).
