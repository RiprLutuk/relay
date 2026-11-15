# Browser transport and session ownership

## Purpose

The MV3 service worker is the browser authority for pairing, workspace selection, session binding, persistent run state, and bridge invocation (`apps/extension/src/transport-entry.ts:15-33`, `apps/extension/src/transport-entry.ts:80-199`).

## Call graph

`chrome.runtime.onMessage` → `handleControl` for popup senders or `handleConversation` for content senders (`apps/extension/src/transport-entry.ts:203-213`). `handleControl(control.start)` → `ensureConversation` → `session.open` → `session.authorize` → `conversation.begin` (`apps/extension/src/transport-entry.ts:105-131`). `handleConversation(run.execute)` → hash operation → `BridgeLink.request(capability.invoke)` (`apps/extension/src/transport-entry.ts:187-198`).

## State invariants

- Records carry binding, target, owning tab, conversation address, run snapshot, and recent events (`apps/extension/src/transport-entry.ts:6-13`).
- A record must match both tab and current bridge epoch before use (`apps/extension/src/transport-entry.ts:52-56`).
- A `runId` must match the bound native session before any content action proceeds (`apps/extension/src/transport-entry.ts:170-176`).
- Popup-only control and content-only action provenance is checked from message sender URL (`apps/extension/src/transport-entry.ts:203-211`).

## Assumptions and open questions

- Assumes the normalized URL plus browser tab is the desired conversation identity (`apps/extension/src/transport-entry.ts:42-49`).
- Assumes persisted records remain meaningful until native session inspection disproves them (`apps/extension/src/transport-entry.ts:90-98`, `apps/extension/src/transport-entry.ts:161-168`).
- Open: should startup failure history be scoped to bridge epoch as records are? Failures are keyed only by conversation key (`apps/extension/src/transport-entry.ts:17-18`, `apps/extension/src/transport-entry.ts:132-139`).
