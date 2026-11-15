# Relay Architecture Dossier

This dossier records observed behavior. It does not rate findings or prescribe changes.

## System map

Relay is a local control plane composed of:

1. A Manifest V3 browser companion. Its service worker is `transport-entry.ts`; supported AI pages receive `conversation-entry.ts`; ChatGPT also receives an early main-world document script. The supported origins and entry bundles are declared in `apps/extension/manifest.json:10-30` and `apps/extension/manifest.json:46-80`.
2. A VS Code companion. It activates for every VS Code session, registers commands/configuration, and loads `out/workspace-companion.js` (`apps/vscode-extension/package.json:19-22`, `apps/vscode-extension/package.json:23-69`).
3. A Rust WebSocket bridge listening only on loopback. It owns authentication, workspace routing, sessions, MCP child processes, action receipts, and activity (`src/bin/relay-bridge.rs:296-390`, `src/bin/relay-bridge.rs:759-805`).
4. A Rust workspace MCP server over stdio. It exposes 24 file, project, VCS, and process capabilities (`src/bin/workspace-tools.rs:180-206`) and implements MCP initialization/list/call (`src/bin/workspace-tools.rs:576-625`).
5. `relayctl`, which locates sibling runtime binaries, starts the bridge in the foreground, checks binary presence, emits the pairing token, and manages custom MCP configuration (`src/bin/relayctl.rs:10-26`, `src/bin/relayctl.rs:63-120`, `src/bin/relayctl.rs:123-177`).

## Entry points and ownership

| Boundary | Entry point | Responsibility |
|---|---|---|
| AI page | `conversation-entry.ts` | Observe assistant turns, submit internal context/receipts, render activity, follow conversation route changes (`apps/extension/src/conversation-entry.ts:9-69`, `apps/extension/src/conversation-entry.ts:104-153`). |
| Browser control popup | `controls-entry.ts` via `control-popup.html` | Select workspace/access and send `control.*` messages; service worker alone accepts those messages from the popup (`apps/extension/src/transport-entry.ts:203-213`). |
| Browser service worker | `transport-entry.ts` | Persist conversation records, own bridge link, bind a tab/conversation to a session, invoke capabilities (`apps/extension/src/transport-entry.ts:15-39`, `apps/extension/src/transport-entry.ts:80-199`). |
| VS Code host | `activate()` | Install browser assets, register editor roots, start packaged runtime, expose commands/status/control center (`apps/vscode-extension/src/workspace-companion.ts:83-180`). |
| Native bridge | `relay-bridge::main()` | Bind loopback port, accept clients, dispatch requests, expire workspace leases, shut down children (`src/bin/relay-bridge.rs:759-805`). |
| Workspace tool host | `workspace-tools::main()` | Read JSON-RPC lines and dispatch MCP calls against one bound root (`src/bin/workspace-tools.rs:576-625`). |

## Action-to-receipt flow

1. The popup asks the service worker to start. The worker verifies explicit full-access approval, injects/locates the content agent, opens a native session for a selected `workspaceId`, authorizes its access mode, persists it, then sends `conversation.begin` to that tab (`apps/extension/src/transport-entry.ts:105-140`).
2. The content agent asks for the capability catalog and submits a `<relay-context>` message to the AI UI (`apps/extension/src/domain/run-coordinator.ts:36-53`). That context describes an exact single-frame action protocol and embeds the catalog (`apps/extension/src/domain/action-frame.ts:30-34`).
3. A 600 ms observer waits for a stable, no-longer-busy assistant turn; it distinguishes prose from a complete action frame (`apps/extension/src/conversation-entry.ts:104-128`, `apps/extension/src/domain/run-coordinator.ts:85-109`).
4. For an action, the coordinator checks the advertised capability name and requests `run.execute` (`apps/extension/src/domain/run-coordinator.ts:110-125`).
5. The service worker derives an operation identity from session, assistant turn, and action, then sends `capability.invoke` over the bridge link (`apps/extension/src/transport-entry.ts:187-198`). `BridgeLink` adds a request id/token and correlates the response (`apps/extension/src/infrastructure/bridge-link.ts:89-98`).
6. The bridge resolves the selected session and capability, applies the per-session execution journal, calls the MCP server, and normalizes MCP content into an action result (`src/bin/relay-bridge.rs:475-541`). The journal coalesces the same operation and rejects a changed payload under that identity (`src/bin/bridge/execution-journal.rs:17-50`).
7. The workspace MCP dispatches the named tool inside `RELAY_WORKSPACE` and returns MCP text plus structured content (`src/bin/workspace-tools.rs:209-214`, `src/bin/workspace-tools.rs:607-616`).
8. The result crosses the same path back. The coordinator renders it and submits a `<relay-receipt>` to the AI conversation, then waits for another reply (`apps/extension/src/domain/run-coordinator.ts:119-130`, `apps/extension/src/domain/action-frame.ts:37-38`).

## Workspace and conversation lifecycle

- Each VS Code window creates a random `windowId` and registers all current workspace folders; folder changes trigger re-registration (`apps/vscode-extension/src/workspace-companion.ts:105-116`).
- Native editor connections authenticate with a bearer token and heartbeat every eight seconds (`apps/vscode-extension/src/editor-session.ts:23-53`).
- The router validates trusted editor identity, deduplicates canonical roots, and assigns each root a random workspace id under the connection owner (`src/bin/bridge/workspace-registry.rs:238-320`).
- A browser record is keyed by normalized conversation address plus tab. Stored records are capped at 100 (`apps/extension/src/transport-entry.ts:23-39`, `apps/extension/src/transport-entry.ts:42-56`).
- A session carries its selected workspace, access mode, its own MCP server instances, cancellation channel, and execution journal (`src/bin/bridge/workspace-registry.rs:126-133`). Closing the editor owner invalidates its roots and closes sessions bound to them (`src/bin/bridge/workspace-registry.rs:204-222`).
- A content run follows a provisional new-chat route to its durable conversation URL; unrelated navigation stops and leaves the run (`apps/extension/src/conversation-entry.ts:71-78`, `apps/extension/src/conversation-entry.ts:109-119`).
- Content scripts recover an active persisted record after reload and retry recovery with bounded exponential delays (`apps/extension/src/conversation-entry.ts:129-142`).

## Trust and access boundaries

- The native socket binds `127.0.0.1`, not an external interface (`src/bin/relay-bridge.rs:763-764`).
- WebSocket upgrades allow extension origins or a native client bearing the token; browser-origin clients then authenticate messages with the token (`src/bin/relay-bridge.rs:645-683`, `src/bin/relay-bridge.rs:687-710`).
- Only native authenticated editor connections may register workspaces (`src/bin/relay-bridge.rs:403-413`).
- Full access requires popup approval and bridge confirmation (`apps/extension/src/transport-entry.ts:109-126`, `src/bin/relay-bridge.rs:545-553`).
- Workspace mode keeps file targets under the canonical root and restricts process executables/arguments; full mode removes those two restrictions (`src/bin/workspace-tools.rs:49-79`, `src/bin/workspace-tools.rs:131-158`).
- The action context explicitly treats file/tool output as untrusted data rather than instructions (`apps/extension/src/domain/action-frame.ts:34`).

## State and concurrency

- Browser state persists conversation records and startup failures in `chrome.storage.local`; writes are serialized through one promise chain (`apps/extension/src/transport-entry.ts:15-39`).
- A per-conversation `starting` set serializes start/stop transitions (`apps/extension/src/transport-entry.ts:99-115`, `apps/extension/src/transport-entry.ts:132-140`).
- A run revision plus abort signal rejects late work after stop/restart; `occupied` prevents concurrent turn handling (`apps/extension/src/domain/run-coordinator.ts:15-24`, `apps/extension/src/domain/run-coordinator.ts:36-54`, `apps/extension/src/domain/run-coordinator.ts:85-104`).
- Bridge calls that can be long-running are spawned with a 16-request semaphore; other requests are handled serially by the connection loop (`src/bin/relay-bridge.rs:693-734`).
- MCP calls are serialized per server by its mutex; workspace/session invalidation races the lock and the running call (`src/bin/bridge/workspace-registry.rs:163-182`).

## Dependencies, build, and packaging

- Rust binaries and native dependencies are declared in `Cargo.toml:1-38`; TypeScript browser and editor components are separate npm packages, with the repository scripts orchestrating checks/build/tests (`package.json:1-16`).
- Browser bundling uses four TypeScript entry points, esbuild IIFEs, and Chrome 120 output (`scripts/build-browser.ts:6-14`).
- VS Code compilation emits `out/workspace-companion.js`; the extension depends on `ws` and VS Code 1.96+ (`apps/vscode-extension/package.json:12-20`, `apps/vscode-extension/package.json:72-85`).
- Packaging targets macOS arm64/x64, Linux arm64/x64, and Windows x64; it verifies version agreement, binary architecture, bundles all three native binaries and the browser companion, creates platform VSIX files, and writes checksums (`scripts/package-release.ts:7-41`, `scripts/package-release.ts:49-90`).

## Verification inventory

- `npm test` performs TypeScript checks, browser build/tests, VS Code build/tests, and `cargo test` (`package.json:8-14`).
- Browser unit coverage currently names conversation-address and extension-lifetime behavior (`apps/extension/test/conversation-address.test.ts:5-23`, `apps/extension/test/extension-lifetime.test.ts:5-12`).
- VS Code tests exercise generated control-center content and runtime upgrade planning (`package.json:12`, `apps/vscode-extension/test/control-center.cjs:1-33`, `apps/vscode-extension/test/runtime-lifecycle.cjs:1-39`).
- Rust integration suites cover WebSocket protocol, workspace routing, MCP stdio, and CLI behavior (`tests/bridge-websocket.rs:63-245`, `tests/workspace-routing.rs:55-313`, `tests/mcp-stdio.rs:50-180`, `tests/relayctl-cli.rs:20-76`).
- Python harnesses provide browser-flow and editor-bootstrap scenarios (`tests/browser-flow.py:1-232`, `tests/editor-bootstrap.py:1-136`). Their invocation is not part of the root `test` script (`package.json:8-14`).

## Focused records

- [Conversation run](functions/conversation-run.md)
- [Browser transport](functions/browser-transport.md)
- [Bridge link](functions/bridge-link.md)
- [Editor registration](functions/editor-registration.md)
- [Native dispatch](functions/native-dispatch.md)
- [Workspace capabilities](functions/workspace-capabilities.md)
- [Packaging and verification](functions/packaging-verification.md)

## Unenforced assumptions observed

- The AI provider will preserve and follow the internal context/action/receipt text protocol. No provider API contract is used; the system observes rendered DOM and submits text (`apps/extension/src/domain/action-frame.ts:30-38`, `apps/extension/src/conversation-entry.ts:37-52`).
- A rendered assistant reply that is stable for two seconds and the page reports as not busy is complete. Nothing found that obtains an authoritative completion event from providers (`apps/extension/src/domain/run-coordinator.ts:90-108`).
- Provider DOM selectors and interaction behavior remain compatible with each site profile. Nothing found that negotiates a provider version (`apps/extension/src/conversation-entry.ts:9-15`, `apps/extension/src/adapters/site-profiles.ts:1-172`).
- A service-worker-stored run snapshot and the visible chat remain semantically aligned after reload. Recovery validates the native session but does not replay or reconcile prior visible receipts (`apps/extension/src/conversation-entry.ts:129-142`, `apps/extension/src/transport-entry.ts:161-168`).
- A native executable selected from configuration or bundled beside the extension is the intended Relay runtime. Nothing found that verifies its publisher/signature before execution (`apps/vscode-extension/src/workspace-companion.ts:31-45`, `apps/vscode-extension/src/workspace-companion.ts:124-146`).
- Custom MCP server commands in local configuration are trusted local configuration. They are launched with configured arguments/environment and session access mode; nothing found that authenticates their implementation (`src/bin/relay-bridge.rs:153-204`, `src/bin/relayctl.rs:84-98`).
- Loopback plus the pairing token is sufficient client identity. Browser messages share one token; nothing found that binds a browser installation/account/provider to a distinct cryptographic identity (`src/bin/relay-bridge.rs:304-310`, `src/bin/relay-bridge.rs:645-710`).

## Open questions

1. Is protocol version 3 intended as a published compatibility contract, and where is its schema/version migration policy maintained? The number is checked independently in browser, editor, and bridge code (`apps/extension/src/infrastructure/bridge-link.ts:59-63`, `apps/vscode-extension/src/editor-session.ts:33-38`, `src/bin/relay-bridge.rs:377-380`).
2. Are browser-flow and editor-bootstrap harnesses release gates, manual diagnostics, or legacy scenarios? They exist but are absent from the root test script (`package.json:8-14`, `tests/browser-flow.py:1-232`, `tests/editor-bootstrap.py:1-136`).
3. What is the intended recovery contract when the bridge response times out after an action may have executed? The browser refuses automatic replay, while the journal can return a cached result only if the same operation is sent again (`apps/extension/src/infrastructure/bridge-link.ts:82-95`, `src/bin/bridge/execution-journal.rs:17-50`).
4. Is one active run per browser conversation an explicit product invariant across browser profiles and accounts, or only an implementation invariant of the local record key (`apps/extension/src/transport-entry.ts:42-56`, `apps/extension/src/transport-entry.ts:106-109`)?
5. Which editor products are supported as product commitments? Registration uses generic VS Code APIs and records `uriScheme`/`appName`, while packaging metadata names VS Code (`apps/vscode-extension/src/workspace-companion.ts:107-113`, `apps/vscode-extension/package.json:2-14`).
