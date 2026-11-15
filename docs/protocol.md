# Protocol

Bridge protocol `3` uses JSON messages over a loopback WebSocket. Browser clients pair with the 64-hex token; native editor clients also send it as a bearer token.

## Action lifecycle

1. `session.open` binds a workspace.
2. `session.authorize` selects Workspace or Full access.
3. `capability.list` returns the current catalog.
4. `capability.invoke` carries `sessionId`, `workspaceId`, tool arguments and a SHA-256 `operationId`.
5. `actionResult` returns `actionId`, `status`, `durationMs`, output or a stable `errorCode`.

Successful actions use `status: completed`. Failures use `status: failed` and one of `ACTION_TIMEOUT`, `PERMISSION_DENIED`, `FILE_NOT_FOUND`, `WORKSPACE_UNAVAILABLE`, or `PROCESS_FAILED`.

The execution journal deduplicates an operation identity within its session. Reusing that identity with different arguments is rejected. Relay does not automatically replay an action after an uncertain disconnect.

Heartbeat intervals are 8 seconds for editor registration and 15 seconds for the browser. Health records the latest successful heartbeat and round-trip latency. Protocol 3 has no compatibility negotiation: browser, editor and native runtime must be upgraded together.
