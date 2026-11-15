# Workspace capability server

## Purpose

Exposes project inspection, file operations, VCS inspection, and developer process execution as one MCP stdio server bound to `RELAY_WORKSPACE` (`src/bin/workspace-tools.rs:34-47`, `src/bin/workspace-tools.rs:180-206`).

## Boundary behavior

- Relative and absolute targets are resolved through the nearest existing ancestor; workspace mode rejects canonical paths outside the root (`src/bin/workspace-tools.rs:49-79`).
- Reads are bounded and marked truncated (`src/bin/workspace-tools.rs:113-126`).
- Workspace mode permits a fixed executable set and narrows Python and Git operations; full mode bypasses those checks (`src/bin/workspace-tools.rs:131-158`).
- `project.run` admits only named safe scripts; `project.test` selects package, Cargo, or Python test execution (`src/bin/workspace-tools.rs:531-571`).
- The stdio loop supports initialize, ping, tools/list, tools/call, and cancellation (`src/bin/workspace-tools.rs:576-625`).

## Assumptions and open questions

- Assumes canonicalizing the nearest existing ancestor is sufficient for paths that do not yet exist (`src/bin/workspace-tools.rs:61-79`).
- Assumes ignored directory names are appropriate for every supported project; nothing found that makes the ignore set workspace-configurable (`src/bin/workspace-tools.rs:102-108`).
- Open: are the 24 capability names a stable public contract or internal implementation detail? They are embedded into AI context and therefore provider-visible (`src/bin/workspace-tools.rs:180-206`, `apps/extension/src/domain/action-frame.ts:34`).
