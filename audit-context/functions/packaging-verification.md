# Packaging and verification

## Build graph

- Root npm scripts check/build/test the browser, build/test VS Code, then run Rust tests (`package.json:5-14`).
- Browser build bundles conversation, transport, controls, and document entry points (`scripts/build-browser.ts:9-14`).
- Release packaging checks a single version across npm, browser manifest, VS Code, and Cargo (`scripts/package-release.ts:30-41`).
- Each platform package compiles all Rust binaries, verifies binary architecture, bundles browser output/assets, builds a target VSIX, and updates SHA-256 sums (`scripts/package-release.ts:43-90`).

## Test boundaries

- Browser unit tests directly name only conversation addressing and extension reload detection (`apps/extension/test/conversation-address.test.ts:5-23`, `apps/extension/test/extension-lifetime.test.ts:5-12`).
- VS Code script tests cover control-center HTML and runtime upgrade parsing (`package.json:12`).
- Rust integration tests cover the native protocol, routing, stdio capability behavior, and CLI (`tests/bridge-websocket.rs:63-245`, `tests/workspace-routing.rs:55-313`, `tests/mcp-stdio.rs:50-180`, `tests/relayctl-cli.rs:20-76`).
- Browser/editor Python harnesses exist outside the default root test command (`tests/browser-flow.py:1-232`, `tests/editor-bootstrap.py:1-136`, `package.json:8-14`).

## Assumptions and open questions

- Packaging assumes required Rust targets and cross toolchains are installed (`scripts/package-release.ts:15-18`, `scripts/package-release.ts:65-69`).
- Open: which test command is the release acceptance gate, and are the Python harnesses expected to run for every supported provider/platform?
