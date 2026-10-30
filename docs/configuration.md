# Configuration

The packaged editor extension starts the bundled runtime. Browser pairing is stored once; project selection and access belong to individual conversations.

## Editor

| Setting | Default | Purpose |
| --- | --- | --- |
| `relay.autoStart` | `true` | Start the local runtime when needed |
| `relay.controlPath` | empty | Optional override for advanced/source installations |

Every window registers all workspace roots. Changing that window's root set, closing it or letting its lease expire invalidates its existing sessions. Remote/non-file workspace URIs are rejected.

## Runtime

| Variable | Purpose |
| --- | --- |
| `RELAY_STATE_DIR` | Override `~/.relay` for tokens, logs and the prepared browser companion |
| `RELAY_BRIDGE_PORT` | Override runtime/editor port `17613`; the packaged browser uses `17613` |
| `RELAY_CONFIG` | Explicit custom-server configuration file |
| `RELAY_WORKSPACE` | Explicit CLI/headless root; normal editor sessions register roots directly |

The runtime binds to loopback and requires its pairing token. Full access is session-scoped; it does not elevate other conversations.

## Optional CLI

```sh
relayctl start
relayctl check
relayctl token
relayctl server list
relayctl server add docs-server /absolute/path/to/server
relayctl server remove docs-server
```

`check` verifies runtime files; it does not run an agent task. The `workspace` server is managed by Relay. Custom MCP processes receive the selected root as their working directory and `RELAY_WORKSPACE`; each custom server implements its own tool behavior. Config lookup uses `RELAY_CONFIG`, a local `config.json`, then the platform's Relay config directory.

## Updates

Install the complete VSIX, reload the editor window, reload the browser extension and refresh the AI tab. Start a new session to receive the matching capability catalog. Pairing is retained unless the token changes.

If upgrading from an earlier development build, stop its incompatible runtime before starting the bundled runtime. This release uses bridge protocol 3 and namespaced capabilities. Legacy managed `vscode` server entries are ignored; the built-in server is named `workspace`.

Verification and packaging run locally. This repository does not use GitHub Actions.
