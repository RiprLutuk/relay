# Editor registration and runtime lifecycle

## Purpose

The VS Code extension starts/discovers Relay, registers trusted workspace roots, publishes status, and installs browser companion assets (`apps/vscode-extension/src/workspace-companion.ts:83-180`).

## Lifecycle and calls

- Activation compares bridge instance version with extension version and may signal the prior process (`apps/vscode-extension/src/workspace-companion.ts:83-95`, `apps/vscode-extension/src/runtime-lifecycle.ts:3-15`).
- Browser assets are copied into the Relay state directory when their build fingerprint changes (`apps/vscode-extension/src/workspace-companion.ts:96-104`).
- `EditorSession.connect` reads the token, authenticates by bearer header, registers after protocol handshake, heartbeats, and reconnects after close (`apps/vscode-extension/src/editor-session.ts:23-64`).
- Registration describes one window and all current folders; changes re-register (`apps/vscode-extension/src/workspace-companion.ts:105-116`).
- Auto-start launches `relayctl start` detached when the runtime health check succeeds (`apps/vscode-extension/src/workspace-companion.ts:124-143`, `apps/vscode-extension/src/workspace-companion.ts:171-180`).

## Assumptions and open questions

- Assumes the first workspace root is the repository containing a development build fallback (`apps/vscode-extension/src/workspace-companion.ts:37-39`).
- Assumes killing a PID from the state file identifies the obsolete Relay process; the plan validates values/version but nothing found that validates process identity (`apps/vscode-extension/src/runtime-lifecycle.ts:3-12`, `apps/vscode-extension/src/workspace-companion.ts:87-93`).
- Open: is activation on every VS Code window required, or could editor registration be demand-driven (`apps/vscode-extension/package.json:19-22`)?
