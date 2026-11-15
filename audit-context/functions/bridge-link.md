# BridgeLink

## Purpose

Maintains the browser service worker's authenticated WebSocket connection and correlates request/response messages (`apps/extension/src/infrastructure/bridge-link.ts:4-17`).

## Lifecycle

- Pairing validates a 64-hex token and opens/authenticates the socket (`apps/extension/src/infrastructure/bridge-link.ts:37-54`).
- A connected response must advertise protocol 3; then a 15-second ping heartbeat starts (`apps/extension/src/infrastructure/bridge-link.ts:55-75`).
- Close rejects every pending request, reports unknown action outcome, and schedules exponential reconnect up to 30 seconds (`apps/extension/src/infrastructure/bridge-link.ts:78-86`).
- Requests carry a monotonic id and token and have an explicit timeout (`apps/extension/src/infrastructure/bridge-link.ts:89-98`).

## Assumptions and open questions

- Assumes one service-worker instance has one sequence namespace; native correlation is per socket (`apps/extension/src/infrastructure/bridge-link.ts:7-13`).
- Nothing found that persists pending requests across service-worker suspension.
- Open: what recovery path is intended for a timed-out request whose journaled native execution later completes (`apps/extension/src/infrastructure/bridge-link.ts:94-97`, `src/bin/bridge/execution-journal.rs:17-50`)?
