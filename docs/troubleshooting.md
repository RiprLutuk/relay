# Troubleshooting

## Popup is not Ready

Open a trusted local folder, run **Relay: Start Control Plane**, then **Relay: Copy Pairing Token** and pair once. Reload the browser extension and refresh an already-open AI tab after an update.

## Session failed

Open **Relay: Open Control Center**. `Connecting` or `Reconnecting` indicates transport recovery; `MCP unavailable` means the bridge is reachable but the workspace server is not ready. The detail line includes heartbeat latency after the first successful health check.

Start a new session when the bridge reports it restarted or the selected editor workspace was closed. Relay intentionally does not replay an action whose outcome is unknown.

## Diagnostics

Run `relayctl check`, inspect **Output → Log (Extension Host)**, and include the exact action error code in a report. Never include `~/.relay/bridge-token`.
