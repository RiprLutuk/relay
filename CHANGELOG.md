# Changelog

## 1.0.0 — 2026-10-30

- One VSIX bundles the editor companion, Rust runtime and browser companion.
- Platform packages cover Windows x64, Linux x64/ARM64 and macOS Intel/Apple Silicon, with native architecture checks and SHA-256 checksums.
- Conversations bind to a specific editor window and project root, with session-scoped access.
- TypeScript browser orchestration provides readable action cards, execution receipts, cancellation and recovery without replaying history.
- Start attaches a missing conversation agent to already-open tabs. Startup errors survive popup refreshes. Claude file creation and read-back are verified live in Brave on macOS.
- Rust routes MCP capabilities, deduplicates retries by operation identity and cancels descendant processes when a session closes.
- VS Code and Cursor bootstrap and browser-to-workspace integration are tested locally. See [verification](docs/verification.md) for coverage and limits.

The initial product release uses bridge protocol 3. Pre-release development history is described in [provenance](PROVENANCE.md).
