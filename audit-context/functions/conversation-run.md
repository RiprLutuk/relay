# ConversationRun

## Purpose

Coordinates one AI conversation from bootstrap context through repeated action execution and receipt submission (`apps/extension/src/domain/run-coordinator.ts:14-24`).

## Inputs and outputs

- Input surface: conversation identity, latest reply, busy state, and text submission (`apps/extension/src/domain/run-coordinator.ts:24-25`, `apps/extension/src/domain/run-coordinator.ts:90-101`).
- Input ports: capability catalog, action executor, state publisher/presenter, workspace label/access, and clock (`apps/extension/src/domain/run-coordinator.ts:4-12`).
- Output: published phase snapshots, UI activity cards, action requests, and receipt messages (`apps/extension/src/domain/run-coordinator.ts:31-34`, `apps/extension/src/domain/run-coordinator.ts:114-129`).

## Guarantees expressed in code

- Refuses a second `begin` while active (`apps/extension/src/domain/run-coordinator.ts:36-38`).
- Does not execute a capability absent from the fetched catalog (`apps/extension/src/domain/run-coordinator.ts:47-51`, `apps/extension/src/domain/run-coordinator.ts:114-118`).
- Uses abort/revision checks before accepting late async results (`apps/extension/src/domain/run-coordinator.ts:38-53`, `apps/extension/src/domain/run-coordinator.ts:102-130`).
- Stops after three consecutive failed results (`apps/extension/src/domain/run-coordinator.ts:123-125`).

## Assumptions and open questions

- Assumes two seconds of unchanged rendered text means the turn is complete; nothing found that obtains provider completion metadata (`apps/extension/src/domain/run-coordinator.ts:96-108`).
- Assumes user prose does not need execution unless it contains the exact action frame (`apps/extension/src/domain/action-frame.ts:5-27`).
- Open: should a recovered run reconcile its saved `lastTurn` against visible receipt history before observing new replies? Restore only reloads the catalog and snapshot (`apps/extension/src/domain/run-coordinator.ts:56-65`).
