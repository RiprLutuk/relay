# Verification — 30 October 2026

## Automated checks

```sh
npm test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

The suite type-checks browser source and build tooling, bundles the extension, tests the conversation lifecycle and transport, compiles the editor companion, and exercises Rust/MCP over real processes and WebSockets.

Native integration covers multiple editor connections, multiple roots, immutable session targets, permission isolation, missing bindings, changed roots and closed owners. Execution-journal tests coalesce concurrent retries and reject operation identities reused with another payload. A running process must not block heartbeat replies; closing its owner must cancel its descendants.

Full-access command tests execute an absolute-path binary outside the Workspace allowlist and, on Unix, remove a temporary file with `rm`. The neighboring Workspace session must still reject the unrestricted executable. Browser bootstrap tests verify that the model receives the selected mode, including its approved Full access scope.

## Browser-to-workspace fixture

```sh
python -m pip install playwright websockets
python -m playwright install chromium
python tests/browser-flow.py
```

Build native binaries and the editor extension first (`cargo build --bins`, `npm run build:vscode`). Set `RELAY_TEST_BROWSER` to use an installed Chromium browser.

This test loads the actual unpacked extension in a fresh browser profile and connects it to real `EditorSession` implementations and the Rust/MCP runtime on an isolated port. Three roots are registered. Two conversations create and read different files in their selected roots, return receipts to their chat fixtures and finish independently. It also verifies virtualized CodeMirror text, readable history after reload, no historical replay, session recovery after stopping the service worker, fresh results after an external edit, independent stop and a 360px layout. After a stopped conversation starts again on another root, a delayed action carrying its old run identity must be rejected without writing to either root.

Set `RELAY_TEST_LATE_ATTACH=1` to open the chat before its content script is registered: Start must attach the real agent without a page reload. Set `RELAY_TEST_STARTUP_FAILURE=1` to verify an unsent draft stays untouched and the startup error survives status polling. One conversation uses explicitly approved Full access; the other uses Workspace access.

The chat page supplies deterministic responses. This verifies transport and orchestration without claiming a live AI model ran the task. The screenshot is `/tmp/relay-browser-flow.png`.

## Live scope

Release packaging covers Windows x64, Linux x64/ARM64 and macOS Intel/Apple Silicon. Each VSIX contains three native binaries whose PE, ELF or Mach-O architecture is checked before packaging, plus the same compiled TypeScript companions. Linux binaries use static musl linkage. Release assets have SHA-256 checksums.

The cross-build used Rust 1.99.1, cargo-zigbuild 0.24.0, Zig 0.17.0 and MinGW-w64 14.0.0. The macOS Intel workspace server also passed MCP initialization, capability listing and a file read under Rosetta; that is not a native Intel editor test.

Cross-compilation verifies that target-specific code builds and links; it does not establish runtime behavior on Windows or Linux. Their editor/browser integrations have not been run on those operating systems here.

The packaged VSIX was installed into isolated **VS Code 1.144** and **Cursor** profiles. Each editor started the bundled Rust runtime without a manual CLI command, prepared the browser companion, registered two roots with its window identity and removed those roots on window shutdown. The detached runtime remained available after its editor window closed.

On macOS Apple Silicon, reproduce with Playwright's Python environment plus `websockets`:

```sh
python -m pip install websockets
RELAY_TEST_EDITOR=vscode python tests/editor-bootstrap.py
RELAY_TEST_EDITOR=cursor python tests/editor-bootstrap.py
```

The script uses temporary profiles and the local VSIX. Leave `RELAY_TEST_EDITOR` unset to test both editors sharing a runtime. Other editors, including Antigravity, have not been verified live here.

Signed-in **Claude in Brave 156.1.98.60 on macOS** was verified live. A pre-existing tab first reproduced the missing content-script error, then Start attached the fixed agent without reloading the chat. A new conversation created `target/relay-live-check.txt` containing `Relay berhasil`, read it back through `workspace.readText`, returned both receipts and settled without an error. The test output is ignored by Git.

The same conversation was explicitly switched to Full access. It created another temporary probe, removed it through `process.run` with `rm`, then used `sh` to verify its absence. Both process calls completed and the session returned to waiting. Full access accepts any installed executable; it does not require a separate language integration or allowlist entry.

ChatGPT's current coverage remains the deterministic fixture. Other providers and operating systems need their own live verification.

Browser site layouts and editors need their own verification. A configured profile or compatible editor API does not, by itself, prove a live integration.
