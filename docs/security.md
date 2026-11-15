# Security model

Relay binds only to loopback and authenticates clients with a local token. Workspaces can be registered only by an authenticated native editor connection.

| Mode | Boundary |
| --- | --- |
| Observe | Only inspection, search, reads and read-only Git operations. |
| Supervised | Workspace edits and safe project scripts run directly; arbitrary processes, moves and mixed-risk batches require exact-action approval. |
| Autonomous | Full filesystem and installed-command access without per-action prompts after explicit session confirmation. |

Autonomous access is not privilege elevation or an OS sandbox; commands still run as the current OS user and may execute trusted project code.

Relay canonicalizes paths, rejects traversal and symlink escapes, scopes approval to a session, bounds tool output and treats repository/tool content as untrusted data. Never paste the pairing token into a chat or commit it.

Known limits: all paired browser clients share one token, selected custom MCP servers are trusted local configuration, and bundled/selected binaries are not signature-verified by Relay.
